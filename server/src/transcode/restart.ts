import path from 'node:path'
import { rm, readdir, unlink } from 'node:fs/promises'
import type { Session } from '../session/types.ts'
import type { HwAccel } from './hwaccel.ts'
import type { Profile } from './profiles.ts'
import { spawnFfmpeg, killFfmpeg, SEGMENT_DURATION_SEC } from './ffmpeg.ts'

/** Grace window after SIGKILL before assuming the process is dead. ffmpeg
 *  releases its file handles synchronously on macOS but exit() callbacks may
 *  schedule a tick; 500ms is empirically sufficient. */
const KILL_DRAIN_MS = 500

/**
 * Serialize ffmpeg restart paths. The kill → rm → spawn sequence is not safe
 * to run concurrently: SIGKILL is delivered immediately but the `exit` event
 * may fire on a future tick, and a second spawn would race it on shared
 * `r{N}/` paths. Callers drop the request if another restart is in flight
 * (the client will retry).
 *
 * Returns true if `fn` ran, false if a restart was already in flight.
 */
export async function withRestartLock(
  session: Session,
  fn: () => Promise<void>,
): Promise<boolean> {
  if (session.ffmpegRestartInFlight) return false
  session.ffmpegRestartInFlight = true
  try {
    await fn()
    return true
  } finally {
    session.ffmpegRestartInFlight = false
  }
}

/** Wait for the current ffmpeg process to exit (or KILL_DRAIN_MS, whichever
 *  comes first). Cancels its timer if exit fires early. */
async function waitForExit(session: Session): Promise<void> {
  const proc = session.ffmpegProcess
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  await new Promise<void>(resolve => {
    const t = setTimeout(resolve, KILL_DRAIN_MS)
    proc.once('exit', () => { clearTimeout(t); resolve() })
  })
}

/**
 * Wipe rendition output files. With `keepInit=true` (seek path), preserves
 * `init.mp4` so MSE's cached codec config stays valid — overwriting init mid-
 * playback causes VTDecompressionOutput errors when the new bytes differ from
 * the bytes MSE first loaded. With `keepInit=false` (audio/codec switch),
 * removes the entire rendition dir tree.
 */
export async function cleanupRenditionFiles(
  session: Session,
  profiles: Profile[],
  opts: { keepInit: boolean },
): Promise<void> {
  await Promise.all(
    profiles.map(async (_, r) => {
      const dir = path.join(session.sessionDir, `r${r}`)
      if (!opts.keepInit) {
        await rm(dir, { recursive: true, force: true })
        return
      }
      const files = await readdir(dir).catch(() => [] as string[])
      await Promise.all(
        files
          .filter(f => f !== 'init.mp4')
          .map(f => unlink(path.join(dir, f)).catch(() => {/* gone */})),
      )
    }),
  )
}

/**
 * Restart ffmpeg at a specific segment offset (used by seek + quality switch).
 * Caller MUST hold the restart lock. Updates `currentStartSegment` and
 * `seekPositionMs` BEFORE spawning so concurrent segment requests in the new
 * range will wait for this run rather than triggering another restart.
 *
 * Keeps init.mp4 from the previous run — see cleanupRenditionFiles.
 */
export async function restartAtSegment(
  session: Session,
  hwAccel: HwAccel,
  profiles: Profile[],
  segNum: number,
): Promise<void> {
  const t0 = Date.now()
  // SIGKILL: we don't need ffmpeg to flush; we wipe its outputs anyway.
  // Saves up to 1.5s of grace-wait on every seek vs. SIGTERM.
  const proc = session.ffmpegProcess
  if (proc && !proc.killed && proc.exitCode === null && proc.signalCode === null) {
    try { proc.kill('SIGKILL') } catch {/* gone */}
    await waitForExit(session)
  }
  await cleanupRenditionFiles(session, profiles, { keepInit: true })
  session.currentStartSegment = segNum
  session.seekPositionMs = segNum * SEGMENT_DURATION_SEC * 1000
  console.log(`Session ${session.id}: restart at seg${segNum} (t=${Date.now() - t0}ms preamble)`)
  await spawnFfmpeg(session, hwAccel, profiles, session.selectedAudioTrack)
  console.log(`Session ${session.id}: restart at seg${segNum} ready (t=${Date.now() - t0}ms total)`)
}

/**
 * Full restart with rendition dir wipe — used when changing audio track or
 * other params that produce a fundamentally different init.mp4 (different
 * codec config). The client must reload its HLS source on the matching
 * `track-changed` / `quality-changed` event so MSE picks up the fresh init.
 */
export async function restartWithReset(
  session: Session,
  hwAccel: HwAccel,
  profiles: Profile[],
  audioTrackIndex: number,
  segNum: number,
): Promise<void> {
  killFfmpeg(session)
  await cleanupRenditionFiles(session, profiles, { keepInit: false })
  session.currentStartSegment = segNum
  session.seekPositionMs = segNum * SEGMENT_DURATION_SEC * 1000
  await spawnFfmpeg(session, hwAccel, profiles, audioTrackIndex)
}
