import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { SubtitleTrack } from '../scanner/probe.ts'
import type { Session } from '../session/types.ts'

const EXTRACT_TIMEOUT_MS = 5 * 60_000 // hard cap to avoid hangs on broken streams

/**
 * Extract embeddable text subtitles to WebVTT files under sessionDir.
 * Spawns one ffmpeg with N -map outputs. Process is attached to
 * session.subtitleProcess so destroy() can kill it. Errors are non-fatal.
 */
export async function extractSubtitles(
  filePath: string,
  subtitleTracks: SubtitleTrack[],
  sessionDir: string,
  session?: Session,
): Promise<void> {
  const embeddable = subtitleTracks.filter(t => t.embeddable)
  if (embeddable.length === 0) return

  await mkdir(sessionDir, { recursive: true })

  const args = ['-i', filePath, '-y', '-vn', '-an']
  for (const track of embeddable) {
    // SECURITY: coerce to integer — index comes from probe but defend the path join anyway
    const idx = Math.trunc(Number(track.index))
    if (!Number.isFinite(idx) || idx < 0) continue
    args.push(
      '-map', `0:s:${idx}`,
      '-c:s', 'webvtt',
      path.join(sessionDir, `sub_${idx}.vtt`),
    )
  }

  // Bail if every track was filtered out by the index guard
  if (args.indexOf('-map') === -1) return

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    if (session) session.subtitleProcess = proc

    let stderrBuf = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      // keep last ~4KB for diagnostics; full output is noisy
      stderrBuf = (stderrBuf + chunk.toString()).slice(-4096)
    })

    // Distinguish a timeout-kill (an error) from a session-cleanup kill
    // (expected, not an error). Both surface as a SIGKILL in the exit handler,
    // so the flag disambiguates them.
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
      reject(new Error(`subtitle extraction timed out after ${EXTRACT_TIMEOUT_MS}ms`))
    }, EXTRACT_TIMEOUT_MS)

    proc.on('error', (err) => {
      clearTimeout(timer)
      if (session) session.subtitleProcess = undefined
      reject(err)
    })

    proc.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (session) session.subtitleProcess = undefined
      if (code === 0) resolve()
      else if (timedOut) reject(new Error(`subtitle extraction timed out after ${EXTRACT_TIMEOUT_MS}ms`))
      else if (signal === 'SIGTERM' || signal === 'SIGKILL') resolve() // killed by destroy — not an error
      else reject(new Error(`ffmpeg subtitle extraction exited code=${code}; tail: ${stderrBuf}`))
    })
  })
}
