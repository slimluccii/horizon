import { readdir } from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { probe, type ProbeResult } from './probe.ts'
import { detectCollections, type Collection } from './collections.ts'
import type { Config } from '../config.ts'

export interface MovieItem extends ProbeResult {
  id: string
  title: string
  year: number
  filePath: string
}

export interface EpisodeItem extends ProbeResult {
  id: string
  showId: string
  showTitle: string
  season: number
  episode: number
  title: string
  filePath: string
}

export interface ShowSummary {
  id: string
  title: string
  seasons: { number: number; episodeCount: number }[]
}

export interface LibraryIndex {
  movies: MovieItem[]
  shows: Map<string, { summary: ShowSummary; episodes: EpisodeItem[] }>
  collections: Collection[]
  byId: Map<string, MovieItem | EpisodeItem>
  rescan(): Promise<void>
}

function movieId(filePath: string) {
  return crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16)
}

const MOVIE_RE = /^(.+?)\s*\((\d{4})\)/
const EPISODE_RE = /S(\d{2})E(\d{2})/i

async function walkDir(dir: string): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await walkDir(full))
    else if (/\.(mkv|mp4|mov|avi|m4v)$/i.test(entry.name)) files.push(full)
  }
  return files
}

async function scanMovies(roots: string[], cacheDir: string): Promise<MovieItem[]> {
  const movies: MovieItem[] = []
  for (const root of roots) {
    const files = await walkDir(root).catch(() => [])
    for (const file of files) {
      const basename = path.basename(file, path.extname(file))
      const match = MOVIE_RE.exec(basename)
      if (!match) continue
      const probeResult = await probe(file, cacheDir).catch(() => null)
      if (!probeResult) continue
      movies.push({
        ...probeResult,
        id: movieId(file),
        title: match[1].trim(),
        year: parseInt(match[2]),
        filePath: file,
      })
    }
  }
  return movies
}

async function scanShows(
  roots: string[],
  cacheDir: string,
): Promise<Map<string, { summary: ShowSummary; episodes: EpisodeItem[] }>> {
  const shows = new Map<string, { summary: ShowSummary; episodes: EpisodeItem[] }>()
  for (const root of roots) {
    const showDirs = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const showDir of showDirs) {
      if (!showDir.isDirectory()) continue
      const showTitle = showDir.name
      const showId = movieId(path.join(root, showDir.name))
      const files = await walkDir(path.join(root, showDir.name)).catch(() => [])
      const episodes: EpisodeItem[] = []
      for (const file of files) {
        const basename = path.basename(file)
        const epMatch = EPISODE_RE.exec(basename)
        if (!epMatch) continue
        const probeResult = await probe(file, cacheDir).catch(() => null)
        if (!probeResult) continue
        episodes.push({
          ...probeResult,
          id: movieId(file),
          showId,
          showTitle,
          season: parseInt(epMatch[1]),
          episode: parseInt(epMatch[2]),
          title: basename.replace(/\.[^.]+$/, ''),
          filePath: file,
        })
      }
      if (episodes.length === 0) continue
      const seasonMap = new Map<number, number>()
      for (const ep of episodes) {
        seasonMap.set(ep.season, (seasonMap.get(ep.season) ?? 0) + 1)
      }
      shows.set(showId, {
        summary: {
          id: showId,
          title: showTitle,
          seasons: [...seasonMap.entries()]
            .map(([number, episodeCount]) => ({ number, episodeCount }))
            .sort((a, b) => a.number - b.number),
        },
        episodes,
      })
    }
  }
  return shows
}

export async function createScanner(cfg: Config): Promise<LibraryIndex> {
  let movies: MovieItem[] = []
  let shows = new Map<string, { summary: ShowSummary; episodes: EpisodeItem[] }>()
  let collections: Collection[] = []
  const byId = new Map<string, MovieItem | EpisodeItem>()

  const index: LibraryIndex = { movies, shows, collections, byId, rescan }

  async function rescan() {
    movies = await scanMovies(cfg.moviesRoots, cfg.cacheDir)
    shows = await scanShows(cfg.showsRoots, cfg.cacheDir)
    collections = detectCollections(movies)
    byId.clear()
    for (const m of movies) byId.set(m.id, m)
    for (const show of shows.values()) {
      for (const ep of show.episodes) byId.set(ep.id, ep)
    }
    index.movies = movies
    index.shows = shows
    index.collections = collections
    console.log(`Library: ${movies.length} movies, ${shows.size} shows`)
  }

  await rescan()
  return index
}
