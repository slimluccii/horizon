import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { SubtitleTrack } from '../scanner/probe.ts'

const execFileAsync = promisify(execFile)

export async function extractSubtitles(
  filePath: string,
  subtitleTracks: SubtitleTrack[],
  sessionDir: string,
): Promise<void> {
  const embeddable = subtitleTracks.filter(t => t.embeddable)
  if (embeddable.length === 0) return

  await mkdir(sessionDir, { recursive: true })

  const args = ['-i', filePath, '-y', '-vn', '-an']
  for (const track of embeddable) {
    args.push(
      '-map', `0:s:${track.index}`,
      '-c:s', 'webvtt',
      path.join(sessionDir, `sub_${track.index}.vtt`),
    )
  }

  await execFileAsync('ffmpeg', args)
}
