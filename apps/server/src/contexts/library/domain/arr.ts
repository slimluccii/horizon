import path from 'node:path'

export interface ArrFolder {
  kind: 'movies' | 'shows'
  folder: string
}

const EVENTS_THAT_CHANGE_FILES = new Set([
  'Download', 'Rename', 'EpisodeFileDelete', 'SeriesDelete', 'MovieFileDelete', 'MovieDelete',
])

function folderOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value.replace(/\/+$/, '') : null
}

/** The library folder a Sonarr or Radarr webhook event touched, or null when nothing on disk changed. */
export function arrFolderFromEvent(payload: unknown): ArrFolder | null {
  if (typeof payload !== 'object' || payload === null) return null
  const { eventType, series, movie } = payload as { eventType?: unknown; series?: { path?: unknown }; movie?: { folderPath?: unknown } }
  if (typeof eventType !== 'string' || !EVENTS_THAT_CHANGE_FILES.has(eventType)) return null
  const show = folderOf(series?.path)
  if (show) return { kind: 'shows', folder: show }
  const film = folderOf(movie?.folderPath)
  if (film) return { kind: 'movies', folder: film }
  return null
}

/**
 * Map a folder as the arr container sees it onto the library roots. The two
 * containers usually mount the same tree at different paths, so the trailing
 * segments are tried under each root and the ones Horizon knows are kept.
 */
export function resolveArrFolder(folder: string, roots: string[], knows: (candidate: string) => boolean): string[] {
  const normalized = path.normalize(folder)
  const segments = normalized.split(path.sep).filter(s => s && s !== '..' && s !== '.')
  const resolved: string[] = []
  for (const root of roots) {
    if (normalized.startsWith(`${root}/`)) { resolved.push(normalized); continue }
    for (let k = 1; k <= segments.length; k++) {
      const candidate = path.join(root, ...segments.slice(-k))
      if (knows(candidate)) { resolved.push(candidate); break }
    }
  }
  return resolved
}
