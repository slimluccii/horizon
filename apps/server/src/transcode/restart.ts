import path from 'node:path'
import { rm, readdir, unlink } from 'node:fs/promises'
import type { Session } from '../session/types.ts'
import type { HwAccel } from './hwaccel.ts'
import type { PlaybackPlan } from './plan.ts'
import type { RenderContext } from './render.ts'
import { spawnFfmpeg, killFfmpeg } from './ffmpeg.ts'
import { SEGMENT_DURATION_SEC } from './segments.ts'

/** Grace window after SIGKILL before assuming the process is dead. ffmpeg
 *  releases its file handles synchronously on macOS but exit() callbacks may
 *  schedule a tick; 500ms is empirically sufficient. */
const KILL_DRAIN_MS = 500

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
  renditionCount: number,
  opts: { keepInit: boolean },
): Promise<void> {
  await Promise.all(
    Array.from({ length: renditionCount }, async (_, r) => {
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

/** Build a RenderContext snapshot from a session at the given segment.
 *  Mutates session.currentStartSegment + seekPositionMs in the same step
 *  so spawnFfmpeg sees the new values and the segment route's in-range
 *  check classifies subsequent requests correctly. */
function applyStartSegment(session: Session, segNum: number): RenderContext {
  session.currentStartSegment = segNum
  session.seekPositionMs = segNum * SEGMENT_DURATION_SEC * 1000
  return {
    sourceFilePath: session.filePath,
    sessionDir: session.sessionDir,
    startSegment: segNum,
    seekPositionMs: session.seekPositionMs,
  }
}

/**
 * Restart ffmpeg at a specific segment offset (used by seek + quality switch).
 * Caller (SessionRuntime) MUST hold the restart lock. Updates session segment
 * bookkeeping BEFORE spawning so concurrent segment requests classify against
 * the new range.
 *
 * Keeps init.mp4 from the previous run — see cleanupRenditionFiles.
 */
export async function restartAtSegment(
  session: Session,
  hwAccel: HwAccel,
  plan: PlaybackPlan,
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
  const renditionCount = plan.method === 'transcode' ? plan.renditions.length : 1
  await cleanupRenditionFiles(session, renditionCount, { keepInit: true })
  const ctx = applyStartSegment(session, segNum)
  console.log(`Session ${session.id}: restart at seg${segNum} (t=${Date.now() - t0}ms preamble)`)
  await spawnFfmpeg(session, hwAccel, plan, ctx)
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
  plan: PlaybackPlan,
  segNum: number,
): Promise<void> {
  killFfmpeg(session)
  const renditionCount = plan.method === 'transcode' ? plan.renditions.length : 1
  await cleanupRenditionFiles(session, renditionCount, { keepInit: false })
  const ctx = applyStartSegment(session, segNum)
  await spawnFfmpeg(session, hwAccel, plan, ctx)
}
