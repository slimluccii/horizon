import { spawn } from 'node:child_process'
import { ErrorCodes } from '@horizon/sdk'
import { mkdir, rm, stat } from 'node:fs/promises'
import { watch } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { HwAccel } from './hwaccel.ts'
import type { Session } from '../session/types.ts'
import type { PlaybackPlan } from './plan.ts'
import { renderArgs, type RenderContext } from './render.ts'

export { SEGMENT_DURATION_SEC, SEG_PAD, segmentName } from './segments.ts'
import { SEGMENT_DURATION_SEC, segmentName } from './segments.ts'

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

/** Backstop poll interval. fs.watch is the primary signal; this catches the
 *  case where the watcher misses an event (filesystems where rename != change,
 *  case-folded volumes) and as the only signal when the parent dir doesn't
 *  exist yet. */
const WAIT_POLL_MS = 250

/** Window required for a file's size to stay constant before we call it
 *  "fully written". Segments are written in append mode: ffmpeg opens the
 *  file → writes N MB → closes. fs.watch fires on every write(), so seeing
 *  the file isn't enough; a static size for this window means no more
 *  appends are in-flight. 100ms gives empirical headroom for buffered write
 *  flush on slower / network filesystems while staying well below a segment
 *  duration (hls.js tolerates fast arrivals). */
const STABLE_WINDOW_MS = 100

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
      // A shrink means the file was rewritten/truncated mid-flight — not
      // stable, so retry. (Equality already implies this, but making it
      // explicit clarifies the invariant: size must hold, never regress.)
      if (s2.size < s1.size) return false
      if (process.env.HORIZON_DEBUG && s2.size !== s1.size) {
        console.log(`waitForFile: ${path.basename(absPath)} still growing ${s1.size}->${s2.size}, retrying`)
      }
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
          // ffmpeg exit is a synchronous failure signal — stop waiting
          // immediately rather than hanging until the deadline. The deadline
          // timer (set below) remains as an independent backstop for the case
          // where ffmpeg is still alive but the file never stabilises.
          const p = session.ffmpegProcess
          if (p && (p.exitCode !== null || p.signalCode !== null)) {
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

/**
 * Spawn ffmpeg for a Session. Pure process orchestration — arg construction
 * is delegated to `renderArgs` from transcode/render.ts. Caller passes the
 * PlaybackPlan + RenderContext stamped for this run.
 *
 * Direct-play returns immediately (no ffmpeg). All other methods spawn and
 * wire stderr capture + exit notification onto the Session's WS socket.
 */
export async function spawnFfmpeg(
  session: Session,
  hwAccel: HwAccel,
  plan: PlaybackPlan,
  ctx: RenderContext,
): Promise<void> {
  const t0 = Date.now()

  if (plan.method === 'direct-play') return

  const renditionCount = plan.method === 'transcode' ? plan.renditions.length : 1
  for (let r = 0; r < renditionCount; r++) {
    await mkdir(path.join(ctx.sessionDir, `r${r}`), { recursive: true })
  }

  const { args, renditionCodecs } = renderArgs(plan, ctx, hwAccel)
  session.renditionCodecs = renditionCodecs

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
        code: ErrorCodes.FFMPEG_SPAWN_FAILED,
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
          code: ErrorCodes.TRANSCODE_FAILED,
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

