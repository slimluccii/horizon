/**
 * Renderer — pure projection of a PlaybackPlan + RenderContext + HwAccel into
 * an ffmpeg argv array. No Session reads, no file IO, no side effects.
 *
 * One entry point: `renderArgs`. Internal dispatch on `plan.method`. Shared
 * helpers (input args, HLS muxer args) extracted so the three branches don't
 * duplicate the boilerplate.
 *
 * See CONTEXT.md → PlaybackPlan / RenderContext.
 */
import type { HwAccel } from './hwaccel.ts'
import type { PlaybackPlan, Rendition } from './plan.ts'
import { buildToneMapPrefix } from './tonemap.ts'

/** Runtime context for a single ffmpeg spawn. Varies per spawn (seek changes
 *  startSegment + seekPositionMs; restart-with-reset only changes the latter
 *  on first frame). */
export interface RenderContext {
  sourceFilePath: string
  sessionDir: string
  /** First segment index this ffmpeg run writes. Matches the static VOD
   *  playlist's URI numbering so seek → fresh ffmpeg from segN. */
  startSegment: number
  /** Position to seek to before the first encoded segment. Sub-segment
   *  precision preserved here (renderer rounds to ms when emitting -ss). */
  seekPositionMs: number
}

export interface RenderedArgs {
  args: string[]
  /** Codec strings for each rendition, in order. Required for the HLS master
   *  playlist's EXT-X-STREAM-INF CODECS attribute. */
  renditionCodecs: string[]
}

import { SEGMENT_DURATION_SEC, SEG_PAD } from './segments.ts'

/** Render the full ffmpeg argv for the plan + context. Direct-play short-
 *  circuits to an empty arg list — caller (`spawnFfmpeg`) checks for empty
 *  and skips the spawn entirely. */
export function renderArgs(
  plan: PlaybackPlan,
  ctx: RenderContext,
  hwAccel: HwAccel,
): RenderedArgs {
  switch (plan.method) {
    case 'direct-play':
      return { args: [], renditionCodecs: [] }
    case 'direct-stream':
      return { args: renderDirectStream(plan, ctx), renditionCodecs: [] }
    case 'partial-transcode':
      return { args: renderPartial(plan, ctx, hwAccel), renditionCodecs: [] }
    case 'transcode':
      return renderTranscode(plan, ctx, hwAccel)
  }
}

// ============================================================================
// Method branches
// ============================================================================

function renderTranscode(plan: PlaybackPlan, ctx: RenderContext, hwAccel: HwAccel): RenderedArgs {
  const args: string[] = []
  args.push(...inputArgs(ctx, hwAccel, { wantHwDecode: true }))
  args.push('-filter_complex', filterGraph(plan, hwAccel))

  const n = plan.renditions.length
  // Map streams: [sv0] + audio, [sv1] + audio, …
  for (let i = 0; i < n; i++) {
    args.push('-map', `[sv${i}]`, '-map', `0:a:${plan.audioTrackIndex}`)
  }
  for (let i = 0; i < n; i++) {
    args.push(...codecArgs(plan.renditions[i], i, hwAccel))
  }
  args.push(...hlsMuxerArgs(ctx, n, /* varStreamMap */ true))

  return { args, renditionCodecs: plan.renditions.map(r => r.videoCodec) }
}

function renderDirectStream(plan: PlaybackPlan, ctx: RenderContext): string[] {
  const args: string[] = []
  // No hwaccel decode — copy path doesn't decode.
  args.push(...inputArgs(ctx, /* hwAccel */ undefined, { wantHwDecode: false }))
  args.push('-map', '0:v:0', '-map', `0:a:${plan.audioTrackIndex}`)
  args.push('-c:v', 'copy', '-c:a', 'copy')
  args.push(...hlsMuxerArgs(ctx, 1, /* varStreamMap */ false))
  return args
}

function renderPartial(plan: PlaybackPlan, ctx: RenderContext, hwAccel: HwAccel): string[] {
  const args: string[] = []
  args.push(...inputArgs(ctx, hwAccel, { wantHwDecode: true }))
  args.push('-map', '0:v:0', '-map', `0:a:${plan.audioTrackIndex}`)
  // Video copy + audio transcode. Use the first (only) rendition's audioBitrate.
  const profile = plan.renditions[0].profile
  args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', `${profile.audioBitrate}k`)
  args.push(...hlsMuxerArgs(ctx, 1, /* varStreamMap */ false))
  return args
}

// ============================================================================
// Shared helpers
// ============================================================================

interface InputOpts { wantHwDecode: boolean }

/** -hwaccel (optional) + -ss (optional) + -thread_queue_size + -i + -copyts (when seeking). */
function inputArgs(ctx: RenderContext, hwAccel: HwAccel | undefined, opts: InputOpts): string[] {
  const seekSecs = ctx.seekPositionMs / 1000
  const args: string[] = []
  if (opts.wantHwDecode && hwAccel && hwAccel.hwaccelDecode.length > 0) {
    args.push(...hwAccel.hwaccelDecode)
  }
  if (seekSecs > 0) args.push('-ss', seekSecs.toFixed(3))
  // -thread_queue_size: ffmpeg's default (8) starves the encoder when the
  // demuxer briefly outpaces decode. 512 covers a few seconds of frames.
  args.push('-thread_queue_size', '512')
  args.push('-i', ctx.sourceFilePath)
  // -copyts: preserve source timestamps. Required mid-stream restarts so
  // segN's PTS matches its name (otherwise HLS thinks segN starts at t=0).
  if (seekSecs > 0) args.push('-copyts')
  return args
}

/** -f hls + segment naming + var_stream_map (when multi-rendition). */
function hlsMuxerArgs(ctx: RenderContext, renditionCount: number, varStreamMap: boolean): string[] {
  const args = [
    '-f', 'hls',
    '-hls_time', String(SEGMENT_DURATION_SEC),
    '-hls_list_size', '0',
    '-start_number', String(ctx.startSegment),
    '-hls_flags', 'independent_segments',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
  ]
  if (varStreamMap) {
    const map = Array.from({ length: renditionCount }, (_, i) => `v:${i},a:${i}`).join(' ')
    args.push(
      '-hls_segment_filename', `${ctx.sessionDir}/r%v/seg%0${SEG_PAD}d.m4s`,
      '-var_stream_map', map,
      `${ctx.sessionDir}/r%v/index.m3u8`,
    )
  } else {
    args.push(
      '-hls_segment_filename', `${ctx.sessionDir}/r0/seg%0${SEG_PAD}d.m4s`,
      `${ctx.sessionDir}/r0/index.m3u8`,
    )
  }
  return args
}

/** Build the filter_complex string. Scale first, then tonemap (tonemap is
 *  CPU-bound, ~quadratic in pixel count). For n=1 skip degenerate split=1. */
function filterGraph(plan: PlaybackPlan, _hwAccel: HwAccel): string {
  const profiles = plan.renditions.map(r => r.profile)
  const n = profiles.length
  const scaleChain = (w: number, h: number) =>
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`

  const toneMapPrefix = plan.needsToneMap ? buildToneMapPrefix(plan.toneMap) : ''

  if (n === 1) {
    const p = profiles[0]
    if (plan.needsToneMap) {
      // toneMapPrefix has trailing `,` by contract; strip before label.
      return `[0:v]${scaleChain(p.width, p.height)},${toneMapPrefix.replace(/,$/, '')}[sv0]`
    }
    return `[0:v]${scaleChain(p.width, p.height)}[sv0]`
  }
  // Multi-rendition: tonemap once, split, scale per rendition.
  const splitLabels = profiles.map((_, i) => `[tv${i}]`).join('')
  const splitNode = `[0:v]${toneMapPrefix}split=${n}${splitLabels}`
  const scaleNodes = profiles.map((p, i) => `[tv${i}]${scaleChain(p.width, p.height)}[sv${i}]`).join(';')
  return `${splitNode};${scaleNodes}`
}

/** Per-rendition codec + bitrate + color tag args. Pinned to H.264 High@4.0
 *  for the reasons explained in plan.ts. */
function codecArgs(rendition: Rendition, i: number, hwAccel: HwAccel): string[] {
  const p = rendition.profile
  return [
    `-c:v:${i}`, hwAccel.h264Encoder,
    `-b:v:${i}`, `${p.videoBitrate}k`,
    `-maxrate:v:${i}`, `${Math.round(p.videoBitrate * 1.1)}k`,
    `-bufsize:v:${i}`, `${p.videoBitrate * 2}k`,
    // Force 8-bit 4:2:0 — VideoToolbox sometimes re-derives 10-bit from HDR
    // source metadata even after tonemap, which breaks avc1.640028 clients.
    `-pix_fmt:v:${i}`, 'yuv420p',
    // Pin SDR/BT.709 color tags — encoder otherwise copies BT.2020 / PQ from
    // the HDR source into the avcC box and AVFoundation rejects the stream.
    `-color_primaries:v:${i}`, 'bt709',
    `-color_trc:v:${i}`, 'bt709',
    `-colorspace:v:${i}`, 'bt709',
    `-color_range:v:${i}`, 'tv',
    `-profile:v:${i}`, 'high',
    `-level:v:${i}`, '4.0',
    `-g:v:${i}`, String(SEGMENT_DURATION_SEC * 24),
    `-force_key_frames:v:${i}`, `expr:gte(t,n_forced*${SEGMENT_DURATION_SEC})`,
    `-sc_threshold:v:${i}`, '0',
    `-c:a:${i}`, 'aac',
    `-b:a:${i}`, `${p.audioBitrate}k`,
    `-ac:a:${i}`, '2',
  ]
}
