import { spawn } from 'node:child_process'
import { mkdir, rm, access, stat } from 'node:fs/promises'
import { watch } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { HwAccel } from './hwaccel.ts'
import type { Profile } from './profiles.ts'
import type { Session } from '../session/types.ts'
import { buildToneMapPrefix } from './tonemap.ts'

/** HLS segment duration in seconds. Must match `-hls_time` below.
 *  Shorter segments = faster first-byte for the player (seg0 arrives sooner)
 *  at the cost of more files on disk + more playlist entries. 1s is
 *  aggressive but works with -g set to match (24 at 24fps = 1s GOP). */
export const SEGMENT_DURATION_SEC = 1
/** Segment number padding (5 digits → supports ~66 hours at 4 s/seg). */
export const SEG_PAD = 5
/** Render a segment filename, e.g. segmentName(42) → "seg00042.m4s". */
export function segmentName(n: number): string {
  return `seg${String(n).padStart(SEG_PAD, '0')}.m4s`
}

/** Pause between SIGTERM and SIGKILL. ffmpeg flushes its trailer here on
 *  graceful shutdown; 2s is empirically enough on macOS HW encoders. */
const SIGTERM_TO_SIGKILL_MS = 2000

/** Bytes of ffmpeg stderr retained per process for diagnostic dumps. ffmpeg
 *  is chatty so a ring buffer of ~16 KB is plenty to capture the last lines. */
const STDERR_TAIL_BYTES = 16_384

/**
 * Per-process stderr tail accessor. Indexed by ChildProcess so multiple
 * concurrent ffmpegs (transcode + subtitle extractor) don't clobber each other.
 * Auto-GC'd when the process reference drops.
 */
const stderrTails = new WeakMap<import('node:child_process').ChildProcess, () => string>()

/** Tail of stderr for the given process, or empty string if not tracked. */
export function getFfmpegStderrTail(proc: import('node:child_process').ChildProcess): string {
  return stderrTails.get(proc)?.() ?? ''
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
  const proc = session.ffmpegProcess
  if (!proc || proc.killed) return
  proc.kill('SIGTERM')
  // Schedule SIGKILL fallback. Cancel on early exit so we don't fire on a
  // dead process (benign but wastes a timer slot).
  const t = setTimeout(() => {
    if (!proc.killed && proc.exitCode === null) proc.kill('SIGKILL')
  }, SIGTERM_TO_SIGKILL_MS)
  proc.once('exit', () => clearTimeout(t))
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

  // Hardware decode — even when tonemapping. Decoded frames sit in GPU memory
  // by default; the filter chain prepends `hwdownload` before the CPU tonemap
  // when needed (see filterGraph below). For non-tonemap paths ffmpeg
  // auto-downloads as required by the scale filter.
  if (hwAccel.hwaccelDecode.length > 0) {
    args.push(...hwAccel.hwaccelDecode)
  }

  if (seekSecs > 0) {
    args.push('-ss', seekSecs.toFixed(3))
  }

  // -thread_queue_size: ffmpeg's default (8) starves the encoder when the
  // demuxer briefly outpaces decode (large GOPs, big files on slow disks).
  // Bumping to 512 covers a few seconds of frames; cheap on memory.
  args.push('-thread_queue_size', '512')
  args.push('-i', filePath)

  // -copyts: preserve source timestamps on output. Required when restarting mid-stream
  // for seek — otherwise output PTS resets to 0 and HLS playlist says segN = N*4s
  // but segment data starts at t=0 → MSE sees discontinuity and decoder errors.
  if (seekSecs > 0) args.push('-copyts')

  // Build filter_complex — required for multi-rendition HLS with per-rendition
  // scale. Per-stream `-vf:N` flags do not work correctly with `-var_stream_map`
  // + a single output template (ffmpeg only keeps the last `-vf` value).
  //
  // Tone-map chain — see transcode/tonemap.ts for operator selection details.
  // We can't do a proper PQ → linear → tonemap → BT.709 chain without libzimg,
  // so the chosen operator drives both the curve and the post-correction.
  const scaleChain = (p: Profile) =>
    `scale=${p.width}:${p.height}:force_original_aspect_ratio=decrease,` +
    `pad=${p.width}:${p.height}:(ow-iw)/2:(oh-ih)/2`

  // macOS videotoolbox hwaccel decodes directly to system memory (p010le for
  // 10-bit HDR), so no hwdownload is needed — the comment about HDR frames
  // being stuck in VRAM applied to CUDA/VAAPI, not VT. Tonemap consumes the
  // software frames directly.
  const toneMapPrefix = needsToneMap ? buildToneMapPrefix(session.toneMap) : ''

  // Build filter graph. Scale FIRST, then tonemap — tonemap is CPU-bound and
  // ~quadratic in pixel count, so scaling 4K→1080p up front cuts the work by
  // ~4x. For n>1 we split after scale so every rendition shares the same
  // tonemap pass. For n=1 (HDR-tonemap path caps to single rendition) skip
  // split — degenerate split=1 has tripped some ffmpeg builds.
  let filterGraph: string
  if (n === 1) {
    filterGraph = `[0:v]${scaleChain(profiles[0])},${toneMapPrefix.replace(/,$/, '')}[sv0]`
    if (!needsToneMap) {
      // No tonemap — trailing comma from toneMapPrefix is gone; trim trailing `,`.
      filterGraph = `[0:v]${scaleChain(profiles[0])}[sv0]`
    }
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
      // Force 8-bit 4:2:0 at the encoder — filter_complex already emits yuv420p
      // but some VideoToolbox builds re-derive pix_fmt from input metadata and
      // emit 10-bit when the source was HDR. That breaks avc1.640028 clients
      // (AVFoundation) which expect 8-bit only and fails silently with -12927.
      `-pix_fmt:v:${i}`, 'yuv420p',
      // Explicit SDR/BT.709 color tags on the output stream. Without these,
      // the encoder copies BT.2020 / SMPTE2084 from the HDR source into the
      // avcC box even after tonemap — AVFoundation then refuses the stream
      // because the declared avc1.640028 codec string can't carry HDR.
      `-color_primaries:v:${i}`, 'bt709',
      `-color_trc:v:${i}`, 'bt709',
      `-colorspace:v:${i}`, 'bt709',
      `-color_range:v:${i}`, 'tv',
      // Pin H.264 profile/level to High@4.0 so the avcC box matches the
      // codec string advertised in the master playlist.
      `-profile:v:${i}`, 'high',
      `-level:v:${i}`, '4.0',
      // GOP in frames. Assumes ~24fps source (common for film content). Matches
      // SEGMENT_DURATION_SEC so every seg starts with a keyframe — required for
      // independent_segments HLS. Higher-fps sources will just have more
      // keyframes than strictly needed; still correct, slightly larger segs.
      `-g:v:${i}`, String(SEGMENT_DURATION_SEC * 24),
      // Force keyframe exactly at the segment boundary timestamp. Some encoders
      // ignore this (h264_videotoolbox usually honours it) but providing it
      // hardens seg cuts for any framerate the source happens to use.
      `-force_key_frames:v:${i}`, `expr:gte(t,n_forced*${SEGMENT_DURATION_SEC})`,
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
    // Note: %v is NOT substituted in hls_fmp4_init_filename (ffmpeg quirk).
    // Each rendition writes to its own r{N}/ dir, so a constant init.mp4 is fine.
    '-hls_fmp4_init_filename', 'init.mp4',
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
  args.push('-thread_queue_size', '512')
  args.push('-i', filePath)
  if (seekSecs > 0) args.push('-copyts')
  args.push('-map', '0:v:0', `-map`, `0:a:${audioTrackIndex}`)
  args.push('-c:v', 'copy', '-c:a', 'copy')
  args.push(
    '-f', 'hls',
    '-hls_time', String(SEGMENT_DURATION_SEC),
    '-hls_list_size', '0',
    '-start_number', String(session.currentStartSegment),
    '-hls_flags', 'independent_segments',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
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
  args.push('-thread_queue_size', '512')
  args.push('-i', filePath)
  if (seekSecs > 0) args.push('-copyts')
  args.push('-map', '0:v:0', '-map', `0:a:${audioTrackIndex}`)
  args.push('-c:v', 'copy', '-c:a', 'aac', `-b:a`, `${profile.audioBitrate}k`)
  args.push(
    '-f', 'hls',
    '-hls_time', String(SEGMENT_DURATION_SEC),
    '-hls_list_size', '0',
    '-start_number', String(session.currentStartSegment),
    '-hls_flags', 'independent_segments',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', `${sessionDir}/r0/seg%0${SEG_PAD}d.m4s`,
    `${sessionDir}/r0/index.m3u8`,
  )
  return args
}

/** Backstop poll interval. fs.watch is the primary signal; this catches the
 *  case where the watcher misses an event (filesystems where rename != change,
 *  case-folded volumes) and as the only signal when the parent dir doesn't
 *  exist yet. */
const WAIT_POLL_MS = 250

/** Window required for a file's size to stay constant before we call it
 *  "fully written". Segments are written in append mode: ffmpeg opens the
 *  file → writes N MB → closes. fs.watch fires on every write(), so seeing
 *  the file isn't enough; a static size for this window means no more
 *  appends are in-flight. 50ms is tight (hls.js tolerates fast arrivals)
 *  but long enough that ffmpeg's next buffered write lands first. */
const STABLE_WINDOW_MS = 50

/**
 * Wait for a file under sessionDir to exist AND finish being written. Uses
 * fs.watch on the parent dir as a low-latency signal (~ms) plus a size-
 * stability check so we don't serve a half-written segment. Bails early if
 * ffmpeg has exited.
 *
 * Why size-stability instead of +temp_file: ffmpeg's `-hls_flags +temp_file`
 * option interacts poorly with `-hls_segment_type fmp4` — segments arrive
 * renamed but with partial mdat boxes, causing hls.js `fragParsingError`.
 * Checking size-stable is safer and works across all muxer configs.
 */
async function waitForFile(session: Session, absPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs

  /** Returns true when file exists and its size has been stable for the window. */
  async function isStable(): Promise<boolean> {
    try {
      const s1 = await stat(absPath)
      if (s1.size === 0) return false
      await new Promise(res => setTimeout(res, STABLE_WINDOW_MS))
      const s2 = await stat(absPath)
      return s2.size === s1.size
    } catch {
      return false
    }
  }

  // Fast path: file already there AND stable.
  if (await isStable()) return true

  return new Promise<boolean>((resolve) => {
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      clearInterval(pollTimer)
      clearTimeout(deadlineTimer)
      try { watcher?.close() } catch {/* already closed */}
      resolve(ok)
    }

    const checkStable = () => {
      if (done) return
      isStable().then(ok => {
        if (ok) finish(true)
        else {
          const p = session.ffmpegProcess
          if (p && (p.exitCode !== null || p.signalCode !== null) && Date.now() >= deadline) {
            finish(false)
          }
        }
      })
    }

    const dir = path.dirname(absPath)
    const target = path.basename(absPath)
    let watcher: ReturnType<typeof watch> | null = null
    try {
      watcher = watch(dir, (_evt, name) => {
        if (name === target) checkStable()
      })
      watcher.on('error', () => {/* ignore — poller is the backstop */})
    } catch {/* dir doesn't exist yet — poller handles it */}

    // Backstop: re-check periodically.
    const pollTimer = setInterval(checkStable, WAIT_POLL_MS)
    const deadlineTimer = setTimeout(() => finish(false), timeoutMs)
  })
}

/**
 * Poll until a specific segment file exists (or ffmpeg exits / timeout).
 * Used both for initial pre-buffer and for seek-triggered restarts where
 * the segment handler waits for the newly-spawned ffmpeg to catch up.
 */
export function waitForSegment(
  session: Session,
  renditionIdx: number,
  segNum: number,
  timeoutMs = 30_000,
): Promise<boolean> {
  return waitForFile(
    session,
    path.join(session.sessionDir, `r${renditionIdx}`, segmentName(segNum)),
    timeoutMs,
  )
}

/** Poll until a rendition's init.mp4 exists. ffmpeg writes it alongside seg0. */
export function waitForInit(
  session: Session,
  renditionIdx: number,
  timeoutMs = 30_000,
): Promise<boolean> {
  return waitForFile(
    session,
    path.join(session.sessionDir, `r${renditionIdx}`, 'init.mp4'),
    timeoutMs,
  )
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
  const t0 = Date.now()

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
  session.spawnedAt = Date.now()

  // Always retain a tail of stderr so we can dump it on failure / timeout.
  let stderrTail = ''
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
    if (process.env.HORIZON_DEBUG) process.stderr.write(chunk)
  })
  stderrTails.set(proc, () => stderrTail)

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

  // Previously: `await waitForInitialSegments(session, renditionCount, 1)` —
  // held the caller until ffmpeg produced seg0 (≈ SEGMENT_DURATION_SEC at best).
  // That wait is redundant: the segment route waits for init.mp4 / segN itself
  // via waitForInit / waitForSegment, so the browser can start requesting as
  // soon as the playlist arrives — which doesn't depend on ffmpeg at all.
  // Resolving early cuts cold-start by one full segment duration.
  console.log(`Session ${session.id}: ffmpeg spawned (${Date.now() - t0}ms setup)`)
}

