import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { SubtitleTrack } from '../../../library/index.ts'
import type { Session } from '../../domain/types.ts'

const EXTRACT_TIMEOUT_MS = 5 * 60_000 // hard cap to avoid hangs on broken streams
const SIDECAR_TIMEOUT_MS = 30_000     // sidecar files are small; conversion is fast

/** Convert one sidecar subtitle file (srt/ass/ssa/vtt) to WebVTT. */
function convertSidecar(sidecarPath: string, outPath: string, session?: Session): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-i', sidecarPath, '-y', '-c:s', 'webvtt', outPath],
      { stdio: ['ignore', 'ignore', 'pipe'] })
    if (session) session.subtitleProcess = proc
    let stderrBuf = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf = (stderrBuf + chunk.toString()).slice(-1024)
    })
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`timed out after ${SIDECAR_TIMEOUT_MS}ms`))
    }, SIDECAR_TIMEOUT_MS)
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (session) session.subtitleProcess = undefined
      if (code === 0) resolve()
      else if (signal === 'SIGTERM' || signal === 'SIGKILL') resolve() // killed by destroy
      else reject(new Error(`exited code=${code}; tail: ${stderrBuf}`))
    })
  })
}

/**
 * Extract embeddable text subtitles to WebVTT files under sessionDir.
 *
 * Embedded text tracks come out of the media file itself (one ffmpeg with N
 * -map outputs). External sidecar tracks (`Movie.en.srt` next to the media)
 * are converted file-by-file afterwards. Both land as `sub_<index>.vtt` where
 * `<index>` is the track's position in the media's merged subtitle list, so
 * the subtitle route needs no special casing. Errors are non-fatal.
 */
export async function extractSubtitles(
  filePath: string,
  subtitleTracks: SubtitleTrack[],
  sessionDir: string,
  session?: Session,
): Promise<void> {
  const embeddable = subtitleTracks.filter(t => t.embeddable && !t.external)
  const external = subtitleTracks.filter(t => t.embeddable && t.external && t.externalFileName)
  if (embeddable.length === 0 && external.length === 0) return

  await mkdir(sessionDir, { recursive: true })

  for (const track of external) {
    const idx = Math.trunc(Number(track.index))
    if (!Number.isFinite(idx) || idx < 0) continue
    // SECURITY: basename() so a crafted externalFileName can't traverse out of
    // the media file's directory.
    const sidecarPath = path.join(path.dirname(filePath), path.basename(track.externalFileName!))
    await convertSidecar(sidecarPath, path.join(sessionDir, `sub_${idx}.vtt`), session)
      .catch(err => console.warn(`sidecar subtitle conversion failed (${sidecarPath}): ${(err as Error).message}`))
  }

  if (embeddable.length === 0) return

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
