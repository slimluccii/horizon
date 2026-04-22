import { spawn } from 'node:child_process'
import { mkdir, rm, access } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { HwAccel } from './hwaccel.ts'
import type { Profile } from './profiles.ts'
import type { Session } from '../session/types.ts'

/** HLS segment duration in seconds. Must match `-hls_time` below. */
export const SEGMENT_DURATION_SEC = 4
/** Segment number padding (5 digits → supports ~66 hours at 4 s/seg). */
export const SEG_PAD = 5
/** Render a segment filename, e.g. segmentName(42) → "seg00042.m4s". */
export function segmentName(n: number): string {
  return `seg${String(n).padStart(SEG_PAD, '0')}.m4s`
}

export async function createSessionDir(sessionId: string): Promise<string> {
  const dir = path.join(os.tmpdir(), 'horizon', 'sessions', sessionId)
  await mkdir(dir, { recursive: true })
  return dir
}

export async function cleanupSessionDir(sessionDir: string): Promise<void> {
  if (!sessionDir) return   // guard: dir not yet assigned (session destroyed before mkdir)
  await rm(sessionDir, { recursive: true, force: true })
}

export function killFfmpeg(session: Session): void {
  if (session.ffmpegProcess && !session.ffmpegProcess.killed) {
    session.ffmpegProcess.kill('SIGTERM')
    setTimeout(() => {
      if (session.ffmpegProcess && !session.ffmpegProcess.killed) {
        session.ffmpegProcess.kill('SIGKILL')
      }
    }, 2000)
  }
}

function isAlive(session: Session): boolean {
  const p = session.ffmpegProcess
  return !!p && !p.killed && p.exitCode === null && p.signalCode === null
}

export function pauseFfmpeg(session: Session): void {
  if (!isAlive(session)) return
  try { session.ffmpegProcess?.kill('SIGSTOP') } catch {/* ESRCH: process gone */}
}

export function resumeFfmpeg(session: Session): void {
  if (!isAlive(session)) return
  try { session.ffmpegProcess?.kill('SIGCONT') } catch {/* ESRCH: process gone */}
}

function buildTranscodeArgs(
  session: Session,
  hwAccel: HwAccel,
  profiles: Profile[],
  audioTrackIndex: number,
): { args: string[]; renditionCodecs: string[] } {
  const { filePath, seekPositionMs, sessionDir, needsToneMap } = session
  const seekSecs = seekPositionMs / 1000
  const n = profiles.length

  const args: string[] = []
  const renditionCodecs: string[] = []

  // Hardware decode only when NOT tone-mapping: HDR frames live in VRAM and cannot
  // pass through CPU software filters (tonemap). For non-HDR, hw decode is safe.
  if (!needsToneMap && hwAccel.hwaccelDecode.length > 0) {
    args.push(...hwAccel.hwaccelDecode)
  }

  if (seekSecs > 0) {
    args.push('-ss', seekSecs.toFixed(3))
  }

  args.push('-i', filePath)

  // Build filter_complex — required for multi-rendition HLS with per-rendition scale.
  // Per-stream -vf:N flags do not work correctly with -var_stream_map + a single
  // output-file template: FFmpeg only keeps the last -vf value for all streams.
  //
  // Tone-map chain: uses built-in `tonemap` filter (no zscale/libzimg required).
  // `tonemap` accepts 10-bit input (p010le / yuv420p10le) and outputs yuv420p.
  //
  // Without libzimg we cannot do a proper PQ → linear → tonemap → BT.709 chain,
  // so the output looks dim (midtones crushed). Compensate with:
  //   • mobius operator + param=0.3  — gentler mid-roll than `hable`, brighter mids
  //   • post-tonemap eq — gamma 1.25 lifts midtones, saturation 1.3 recovers color
  //     loss from the simplified tonemap, contrast 1.05 restores local contrast
  // For a correct HDR→SDR pipeline, install an ffmpeg built with --enable-libzimg.
  const scaleChain = (p: Profile) =>
    `scale=${p.width}:${p.height}:force_original_aspect_ratio=decrease,` +
    `pad=${p.width}:${p.height}:(ow-iw)/2:(oh-ih)/2`

  const toneMapPrefix = needsToneMap
    ? 'tonemap=tonemap=mobius:param=0.3:desat=0:peak=100,format=yuv420p,'
      + 'eq=gamma=1.25:saturation=1.3:contrast=1.05,'
    : ''

  // Build filter graph. For n>1 we need split=N to fan out to per-rendition scale.
  // For n=1 (HDR-tonemap path now caps to single rendition) skip split — degenerate
  // split=1 has tripped some ffmpeg builds; a straight chain is simpler anyway.
  let filterGraph: string
  if (n === 1) {
    filterGraph = `[0:v]${toneMapPrefix}${scaleChain(profiles[0])}[sv0]`
  } else {
    const splitLabels = profiles.map((_, i) => `[tv${i}]`).join('')
    const splitNode = `[0:v]${toneMapPrefix}split=${n}${splitLabels}`
    const scaleNodes = profiles.map((p, i) => `[tv${i}]${scaleChain(p)}[sv${i}]`).join(';')
    filterGraph = `${splitNode};${scaleNodes}`
  }
  args.push('-filter_complex', filterGraph)

  // Map streams: [sv0] + audio, [sv1] + audio, …
  for (let i = 0; i < n; i++) {
    args.push('-map', `[sv${i}]`, '-map', `0:a:${audioTrackIndex}`)
  }

  // Per-rendition codec + bitrate settings.
  // Always H264: hevc_videotoolbox does not support per-stream -sc_threshold / -bufsize
  // options in var_stream_map mode, producing broken fMP4 output on macOS.
  for (let i = 0; i < n; i++) {
    const p = profiles[i]
    const vEncoder = hwAccel.h264Encoder
    renditionCodecs.push('avc1.640028')

    args.push(
      `-c:v:${i}`, vEncoder,
      `-b:v:${i}`, `${p.videoBitrate}k`,
      `-maxrate:v:${i}`, `${Math.round(p.videoBitrate * 1.1)}k`,
      `-bufsize:v:${i}`, `${p.videoBitrate * 2}k`,
      `-g:v:${i}`, '48',
      `-sc_threshold:v:${i}`, '0',
      `-c:a:${i}`, 'aac',
      `-b:a:${i}`, `${p.audioBitrate}k`,
      `-ac:a:${i}`, '2',
    )
  }

  const varStreamMap = profiles.map((_, i) => `v:${i},a:${i}`).join(' ')
  args.push(
    '-f', 'hls',
    '-hls_time', String(SEGMENT_DURATION_SEC),
    '-hls_list_size', '0',
    // start_number is the first segment index ffmpeg writes. Matched to
    // session.currentStartSegment so files on disk line up with the static
    // VOD playlist's URI numbering (seek jumps to seg N → ffmpeg resumes at N).
    '-start_number', String(session.currentStartSegment),
    '-hls_flags', 'independent_segments',
    '-hls_segment_type', 'fmp4',
    // %v in init filename — without this, the HLS muxer writes plain init.mp4
    // for var_stream_map outputs, but our static playlist references init_0.mp4 etc.
    '-hls_fmp4_init_filename', 'init_%v.mp4',
    '-hls_segment_filename', `${sessionDir}/r%v/seg%0${SEG_PAD}d.m4s`,
    '-var_stream_map', varStreamMap,
    `${sessionDir}/r%v/index.m3u8`,
  )

  return { args, renditionCodecs }
}

function buildDirectStreamArgs(
  session: Session,
  audioTrackIndex: number,
): string[] {
  const { filePath, seekPositionMs, sessionDir } = session
  const seekSecs = seekPositionMs / 1000
  const args: string[] = []
  if (seekSecs > 0) args.push('-ss', seekSecs.toFixed(3))
  args.push('-i', filePath)
  args.push('-map', '0:v:0', `-map`, `0:a:${audioTrackIndex}`)
  args.push('-c:v', 'copy', '-c:a', 'copy')
  args.push(
    '-f', 'hls',
    '-hls_time', String(SEGMENT_DURATION_SEC),
    '-hls_list_size', '0',
    '-start_number', String(session.currentStartSegment),
    '-hls_flags', 'independent_segments',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init_0.mp4',
    '-hls_segment_filename', `${sessionDir}/r0/seg%0${SEG_PAD}d.m4s`,
    `${sessionDir}/r0/index.m3u8`,
  )
  return args
}

function buildPartialTranscodeArgs(
  session: Session,
  hwAccel: HwAccel,
  profile: Profile,
  audioTrackIndex: number,
): string[] {
  const { filePath, seekPositionMs, sessionDir } = session
  const seekSecs = seekPositionMs / 1000
  const args: string[] = []
  if (hwAccel.hwaccelDecode.length > 0) args.push(...hwAccel.hwaccelDecode)
  if (seekSecs > 0) args.push('-ss', seekSecs.toFixed(3))
  args.push('-i', filePath)
  args.push('-map', '0:v:0', '-map', `0:a:${audioTrackIndex}`)
  args.push('-c:v', 'copy', '-c:a', 'aac', `-b:a`, `${profile.audioBitrate}k`)
  args.push(
    '-f', 'hls',
    '-hls_time', String(SEGMENT_DURATION_SEC),
    '-hls_list_size', '0',
    '-start_number', String(session.currentStartSegment),
    '-hls_flags', 'independent_segments',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init_0.mp4',
    '-hls_segment_filename', `${sessionDir}/r0/seg%0${SEG_PAD}d.m4s`,
    `${sessionDir}/r0/index.m3u8`,
  )
  return args
}

/**
 * Poll until a specific segment file exists (or ffmpeg exits / timeout).
 * Used both for initial pre-buffer and for seek-triggered restarts where
 * the segment handler waits for the newly-spawned ffmpeg to catch up.
 */
export async function waitForSegment(
  session: Session,
  renditionIdx: number,
  segNum: number,
  timeoutMs = 30_000,
): Promise<boolean> {
  const segPath = path.join(session.sessionDir, `r${renditionIdx}`, segmentName(segNum))
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await access(segPath)
      return true
    } catch {/* not yet */}
    // Bail early if ffmpeg died
    const p = session.ffmpegProcess
    if (p && (p.exitCode !== null || p.signalCode !== null)) return false
    await new Promise(r => setTimeout(r, 100))
  }
  return false
}

/**
 * Wait for the first few segments from the current start offset — used on spawn
 * to signal `session-ready` to the client once there's enough to begin playback.
 */
export async function waitForInitialSegments(
  session: Session,
  renditionCount: number,
  minSegments = 3,
): Promise<void> {
  const start = session.currentStartSegment
  for (let r = 0; r < renditionCount; r++) {
    for (let s = 0; s < minSegments; s++) {
      const ok = await waitForSegment(session, r, start + s, 30_000)
      if (!ok) throw new Error(`FFmpeg pre-buffer timeout (r${r} seg${start + s})`)
    }
  }
}

export async function spawnFfmpeg(
  session: Session,
  hwAccel: HwAccel,
  profiles: Profile[],
  audioTrackIndex: number,
): Promise<void> {
  const { sessionDir, method } = session

  const renditionCount = method === 'transcode' ? profiles.length : 1
  for (let r = 0; r < renditionCount; r++) {
    await mkdir(path.join(sessionDir, `r${r}`), { recursive: true })
  }

  let args: string[]
  if (method === 'transcode') {
    const result = buildTranscodeArgs(session, hwAccel, profiles, audioTrackIndex)
    args = result.args
    session.renditionCodecs = result.renditionCodecs
  } else if (method === 'direct-stream') {
    args = buildDirectStreamArgs(session, audioTrackIndex)
  } else if (method === 'partial-transcode') {
    args = buildPartialTranscodeArgs(session, hwAccel, profiles[0], audioTrackIndex)
  } else {
    return
  }

  if (process.env.HORIZON_DEBUG) {
    console.log(`Session ${session.id}: spawn ffmpeg ${['-y', ...args].join(' ')}`)
  }
  const proc = spawn('ffmpeg', ['-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  session.ffmpegProcess = proc
  session.ffmpegPid = proc.pid

  // Always retain a tail of stderr so we can dump it on failure / timeout.
  // ffmpeg is chatty so a ring buffer of ~16 KB is plenty.
  const STDERR_TAIL_BYTES = 16_384
  let stderrTail = ''
  proc.stderr?.on('data', (chunk: Buffer) => {
    const s = chunk.toString('utf8')
    stderrTail = (stderrTail + s).slice(-STDERR_TAIL_BYTES)
    if (process.env.HORIZON_DEBUG) process.stderr.write(chunk)
  })
  // Expose for waitForInitialSegments to dump on timeout.
  ;(proc as any)._horizonStderrTail = () => stderrTail

  proc.on('error', (err) => {
    console.error(`Session ${session.id}: ffmpeg spawn error: ${err.message}`)
    try {
      session.wsSocket?.send(JSON.stringify({
        type: 'error',
        code: 'ffmpeg-spawn-failed',
        message: err.message,
        fatal: true,
      }))
    } catch {/* socket may be gone */}
  })

  proc.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(
        `Session ${session.id}: ffmpeg exited code=${code} signal=${signal}\n` +
        `=== ffmpeg stderr tail ===\n${stderrTail}\n=== end ===`,
      )
      try {
        session.wsSocket?.send(JSON.stringify({
          type: 'error',
          code: 'transcode-failed',
          message: `FFmpeg exited with code ${code}`,
          fatal: true,
        }))
      } catch {/* socket may be gone */}
    } else if (code === 0) {
      try { session.wsSocket?.send(JSON.stringify({ type: 'ended' })) } catch {/* gone */}
    }
  })

  // Only wait for 1 seg per rendition before signaling ready — getting the first
  // segment to disk usually means the HW encoder is fully warm and steady-state.
  try {
    await waitForInitialSegments(session, renditionCount, 1)
  } catch (err) {
    console.error(
      `Session ${session.id}: pre-buffer failed — ${(err as Error).message}\n` +
      `=== ffmpeg stderr tail ===\n${stderrTail}\n=== end ===`,
    )
    throw err
  }
}

/**
 * Restart ffmpeg at a specific segment offset (used by seek). Caller MUST
 * hold the restart lock. Updates session.currentStartSegment + seekPositionMs
 * BEFORE spawning so concurrent segment requests in the same range will wait
 * for this run to produce them rather than triggering another restart.
 */
export async function restartAtSegment(
  session: Session,
  hwAccel: HwAccel,
  profiles: Profile[],
  segNum: number,
): Promise<void> {
  const t0 = Date.now()
  // SIGKILL not SIGTERM — we don't need ffmpeg to flush; we wipe its outputs.
  // Saves up to 1.5s of grace-wait on every seek.
  const old = session.ffmpegProcess
  if (old && !old.killed && old.exitCode === null && old.signalCode === null) {
    try { old.kill('SIGKILL') } catch {/* gone */}
    await new Promise<void>(resolve => {
      const t = setTimeout(resolve, 500)
      old.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
  // Parallel rm — was sequential, ~150ms saved on 4-rendition restarts.
  await Promise.all(
    profiles.map((_, r) => rm(path.join(session.sessionDir, `r${r}`), { recursive: true, force: true })),
  )
  session.currentStartSegment = segNum
  session.seekPositionMs = segNum * SEGMENT_DURATION_SEC * 1000
  console.log(`Session ${session.id}: restart at seg${segNum} (t=${Date.now() - t0}ms preamble)`)
  await spawnFfmpeg(session, hwAccel, profiles, session.selectedAudioTrack)
  console.log(`Session ${session.id}: restart at seg${segNum} ready (t=${Date.now() - t0}ms total)`)
}
