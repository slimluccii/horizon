/**
 * Sidecar subtitle discovery — finds external subtitle files next to a media
 * file (`Movie (2010).en.srt` beside `Movie (2010).mkv`) and presents them as
 * SubtitleTracks appended after the media's embedded tracks.
 *
 * Matching rule (Plex/Jellyfin convention): the sidecar's basename must start
 * with the media file's basename; anything between that prefix and the
 * subtitle extension is read as dot-separated tags — a 2/3-letter language
 * code and/or the word "forced". Runs during Scan, so results are stored on
 * the MediaItem row and visible to clients before playback starts.
 */
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { SubtitleTrack } from '../probe/probe.ts'

/** Sidecar extensions we can convert to WebVTT with ffmpeg. */
const SIDECAR_EXTS: Record<string, string> = {
  '.srt': 'subrip',
  '.ass': 'ass',
  '.ssa': 'ssa',
  '.vtt': 'webvtt',
}

const LANG_RE = /^[a-z]{2,3}$/i

export interface Sidecar {
  fileName: string
  codec: string
  language: string
  forced: boolean
}

/** Find sidecar subtitle files for `mediaFilePath`. Errors (unreadable dir)
 *  resolve to [] — sidecars are an enhancement, never a scan failure. */
export async function discoverSidecarSubtitles(mediaFilePath: string): Promise<Sidecar[]> {
  const dir = path.dirname(mediaFilePath)
  const mediaBase = path.basename(mediaFilePath, path.extname(mediaFilePath))
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const found: Sidecar[] = []
  for (const name of entries) {
    const ext = path.extname(name).toLowerCase()
    const codec = SIDECAR_EXTS[ext]
    if (!codec) continue
    const base = name.slice(0, -ext.length)
    if (base !== mediaBase && !base.startsWith(`${mediaBase}.`)) continue

    const tags = base === mediaBase ? [] : base.slice(mediaBase.length + 1).split('.')
    const language = tags.find(t => LANG_RE.test(t) && t.toLowerCase() !== 'forced')?.toLowerCase() ?? 'und'
    const forced = tags.some(t => t.toLowerCase() === 'forced')
    found.push({ fileName: name, codec, language, forced })
  }
  // Deterministic order so repeated scans produce identical track lists.
  found.sort((a, b) => a.fileName.localeCompare(b.fileName))
  return found
}

/** Append sidecar tracks after the embedded ones. Embedded tracks keep their
 *  probe indexes (which double as ffmpeg `0:s:N` positions); externals get the
 *  following indexes. */
export function mergeSidecarTracks(embedded: SubtitleTrack[], sidecars: Sidecar[]): SubtitleTrack[] {
  const external: SubtitleTrack[] = sidecars.map((s, j) => ({
    index: embedded.length + j,
    codec: s.codec,
    language: s.language,
    forced: s.forced,
    embeddable: true,
    external: true,
    externalFileName: s.fileName,
  }))
  return [...embedded, ...external]
}
