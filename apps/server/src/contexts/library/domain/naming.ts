import path from 'node:path'

export interface MovieName {
  title: string
  year: number
}

export interface EpisodeName {
  season: number
  episode: number
  /** Last episode in the file; equals `episode` for a single-episode file. */
  episodeEnd: number
  title: string | null
}

const TITLE_YEAR_RE = /^(.+?)\s*\((\d{4})\)/
const SXXEXX_RE = /(?:^|[^a-z0-9])s(\d{1,4})e(\d{1,4})(?:(?:-?e|-)(\d{1,4})(?![\dpi]))?/i
const NXNN_RE = /(?:^|[^a-z0-9])(\d{1,2})x(\d{1,3})(?!\d)/i
const QUALITY_RE = /\s+(?:webdl|web-dl|webrip|web|bluray|hdtv|sdtv|dvd|remux|raw-hd)\b.*$/i
const EXTRA_SUFFIX_RE = /-(?:trailer|featurette|behindthescenes|deleted|sample|interview)$/i
const EXTRA_FOLDERS = new Set([
  'extras', 'featurettes', 'trailers', 'behind the scenes', 'deleted scenes', 'interviews', 'sample', 'samples',
])

function stem(file: string): string {
  return path.basename(file, path.extname(file))
}

function titleAndYear(name: string): MovieName | null {
  const m = TITLE_YEAR_RE.exec(name)
  return m ? { title: m[1].trim(), year: parseInt(m[2], 10) } : null
}

export function parseMovieFile(file: string): MovieName | null {
  return titleAndYear(stem(file)) ?? titleAndYear(path.basename(path.dirname(file)))
}

function episodeTitle(rest: string): string | null {
  const m = /^\s*-\s*(?:\d{2,4}\s*-\s*)?(.+)$/.exec(rest)
  if (!m) return null
  const title = m[1].replace(/\s*\[.*$/, '').replace(QUALITY_RE, '').trim()
  return title || null
}

export function parseEpisodeFile(file: string): EpisodeName | null {
  const name = stem(file)
  const m = SXXEXX_RE.exec(name) ?? NXNN_RE.exec(name)
  if (!m) return null
  const season = parseInt(m[1], 10)
  const episode = parseInt(m[2], 10)
  const end = m[3] ? parseInt(m[3], 10) : episode
  return {
    season,
    episode,
    episodeEnd: end > episode ? end : episode,
    title: episodeTitle(name.slice(m.index + m[0].length)),
  }
}

export function isExtra(file: string): boolean {
  const name = stem(file)
  if (EXTRA_SUFFIX_RE.test(name) || name.toLowerCase() === 'sample') return true
  return path.dirname(file).split(path.sep).some(dir => EXTRA_FOLDERS.has(dir.toLowerCase()))
}
