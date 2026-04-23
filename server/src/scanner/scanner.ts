import { readdir } from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { probe } from './probe.ts'
import { detectCollections } from './collections.ts'
import { parseIdsFromPath, parseIds, mergeIds } from './ids.ts'
import { pMap } from './concurrency.ts'
import type { MediaRepo, MovieUpsert, EpisodeUpsert } from '../repos/media.ts'
import type { CollectionsRepo, Collection } from '../repos/collections.ts'
import type { TmdbProvider } from '../metadata/tmdb.ts'

export interface ScanConfig {
  moviesRoots: string[]
  showsRoots: string[]
  cacheDir: string
  scanConcurrency: number
}

export interface ScanDeps {
  media: MediaRepo
  collections: CollectionsRepo
  tmdb: TmdbProvider | null
}

const MOVIE_RE = /^(.+?)\s*\((\d{4})\)/
const EPISODE_RE = /S(\d{2})E(\d{2})/i

function hashId(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 16)
}

/** Strip trailing metadata tags like `{tvdb-123}` / `[source]` + year parens
 *  from a directory or filename title. */
function cleanTitle(raw: string): string {
  return raw
    .replace(/\s*\{[^}]+\}/g, '')      // {tvdb-123}, {tmdb-456}
    .replace(/\s*\[[^\]]+\]/g, '')     // [source], [HMAX]
    .replace(/\s*\(\d{4}\)/, '')       // year
    .trim()
}

/** Derive an episode display title from its filename. Looks for the segment
 *  immediately following `SxxExx - `; falls back to a cleaned-up basename. */
function episodeTitle(basename: string): string {
  const stripped = basename.replace(/\.[^.]+$/, '')
  const m = /S\d{2}E\d{2}\s*-\s*([^[]+?)(?:\s*\[|\s*-\s*\[|$)/i.exec(stripped)
  if (m) return m[1].trim()
  return cleanTitle(stripped)
}

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

/** Walk a movies root, probe, upsert into media_items.
 *  Returns the set of ids that were seen (for soft-delete reconciliation). */
async function scanMoviesRoot(
  root: string,
  cfg: ScanConfig,
  media: MediaRepo,
): Promise<Set<string>> {
  const seen = new Set<string>()
  const files = await walkDir(root).catch(() => [])
  const candidates = files
    .map(file => {
      const base = path.basename(file, path.extname(file))
      const m = MOVIE_RE.exec(base)
      return m ? { file, base, m } : null
    })
    .filter((x): x is NonNullable<typeof x> => !!x)

  const { stat } = await import('node:fs/promises')
  await pMap(candidates, cfg.scanConcurrency, async ({ file, m }) => {
    const p = await probe(file, cfg.cacheDir).catch(() => null)
    if (!p) return
    const st = await stat(file)
    const id = hashId(file)
    const upsert: MovieUpsert = {
      id,
      filePath: file,
      title: m[1].trim(),
      sortYear: parseInt(m[2], 10),
      durationSec: p.duration,
      resolution: p.resolution,
      videoCodec: p.videoCodec,
      container: p.container,
      hdr: p.hdr,
      audioTracks: p.audioTracks,
      subtitleTracks: p.subtitleTracks,
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      externalIds: parseIdsFromPath(file),
      metadata: null,
    }
    media.upsertMovie(upsert)
    seen.add(id)
  })
  return seen
}

async function scanShowsRoot(
  root: string,
  cfg: ScanConfig,
  media: MediaRepo,
): Promise<Set<string>> {
  const seen = new Set<string>()
  const showDirs = await readdir(root, { withFileTypes: true }).catch(() => [])
  const { stat } = await import('node:fs/promises')
  for (const showDirEnt of showDirs) {
    if (!showDirEnt.isDirectory()) continue
    const showDirAbs = path.join(root, showDirEnt.name)
    const showId = hashId(showDirAbs)
    media.upsertShow({
      id: showId,
      title: cleanTitle(showDirEnt.name),
      sortYear: null,
      externalIds: parseIds(showDirEnt.name),
      metadata: null,
    })
    seen.add(showId)

    const files = await walkDir(showDirAbs).catch(() => [])
    const epCands = files
      .map(file => {
        const base = path.basename(file)
        const em = EPISODE_RE.exec(base)
        return em ? { file, base, em } : null
      })
      .filter((x): x is NonNullable<typeof x> => !!x)

    await pMap(epCands, cfg.scanConcurrency, async ({ file, base, em }) => {
      const p = await probe(file, cfg.cacheDir).catch(() => null)
      if (!p) return
      const st = await stat(file)
      const id = hashId(file)
      const insert: EpisodeUpsert = {
        id,
        parentId: showId,
        filePath: file,
        title: episodeTitle(base),
        season: parseInt(em[1], 10),
        episode: parseInt(em[2], 10),
        durationSec: p.duration,
        resolution: p.resolution,
        videoCodec: p.videoCodec,
        container: p.container,
        hdr: p.hdr,
        audioTracks: p.audioTracks,
        subtitleTracks: p.subtitleTracks,
        mtimeMs: st.mtimeMs,
        sizeBytes: st.size,
        externalIds: mergeIds(parseIds(showDirEnt.name), parseIds(base)),
        metadata: null,
      }
      media.upsertEpisode(insert)
      seen.add(id)
    })
  }
  return seen
}

/** One-shot scan: walks roots, upserts rows, soft-deletes missing, rebuilds
 *  collections. TMDB enrichment happens after (background). */
export async function rescan(cfg: ScanConfig, deps: ScanDeps): Promise<void> {
  const t0 = Date.now()
  const seen = new Set<string>()
  for (const r of cfg.moviesRoots) {
    for (const id of await scanMoviesRoot(r, cfg, deps.media)) seen.add(id)
  }
  for (const r of cfg.showsRoots) {
    for (const id of await scanShowsRoot(r, cfg, deps.media)) seen.add(id)
  }
  deps.media.softDeleteMissing(seen)

  const movies = deps.media.listMovies()
  const detected = detectCollections(movies)
  const collections: Collection[] = detected.map(c => ({
    id: hashId(c.name),
    name: c.name,
    movieIds: c.movies.map(m => m.id),
  }))
  deps.collections.replaceAll(collections)
  console.log(`Library: ${movies.length} movies, ${deps.media.listShows().length} shows (scan ${Date.now() - t0}ms)`)

  if (deps.tmdb) void backgroundEnrich(deps.tmdb, deps.media)
}

async function backgroundEnrich(tmdb: TmdbProvider, media: MediaRepo): Promise<void> {
  const t0 = Date.now()
  const movies = media.listMovies()
  const shows = media.listShows()
  const tasks: Promise<void>[] = []

  for (const mv of movies) {
    tasks.push((async () => {
      const ids = mv.externalIds
      let m = ids.tmdb ? await tmdb.movieByTmdbId(ids.tmdb) : null
      if (!m && ids.imdb) m = await tmdb.movieByImdbId(ids.imdb)
      if (!m) m = await tmdb.searchMovie(mv.title, mv.sortYear ?? undefined)
      if (m) {
        media.upsertMovie({
          id: mv.id,
          filePath: mv.filePath!,
          title: mv.title,
          sortYear: mv.sortYear,
          durationSec: mv.durationSec!,
          resolution: mv.resolution!,
          videoCodec: mv.videoCodec!,
          container: mv.container!,
          hdr: mv.hdr!,
          audioTracks: mv.audioTracks!,
          subtitleTracks: mv.subtitleTracks!,
          mtimeMs: mv.mtimeMs!,
          sizeBytes: mv.sizeBytes!,
          externalIds: mv.externalIds,
          metadata: m,
        })
      }
    })())
  }

  for (const sh of shows) {
    tasks.push((async () => {
      const ids = sh.externalIds
      let s = ids.tmdb ? await tmdb.showByTmdbId(ids.tmdb) : null
      if (!s && ids.tvdb) s = await tmdb.showByTvdbId(ids.tvdb)
      if (!s) s = await tmdb.searchShow(sh.title)
      if (!s) return
      media.upsertShow({
        id: sh.id,
        title: sh.title,
        sortYear: sh.sortYear,
        externalIds: sh.externalIds,
        metadata: s,
      })
      const eps = media.getEpisodes(sh.id)
      await Promise.all(eps.map(async ep => {
        const epMeta = s!.tmdbId ? await tmdb.episode(s!.tmdbId, ep.season!, ep.episode!) : null
        if (!epMeta) return
        media.upsertEpisode({
          id: ep.id,
          parentId: sh.id,
          filePath: ep.filePath!,
          title: epMeta.title ?? ep.title,
          season: ep.season!,
          episode: ep.episode!,
          durationSec: ep.durationSec!,
          resolution: ep.resolution!,
          videoCodec: ep.videoCodec!,
          container: ep.container!,
          hdr: ep.hdr!,
          audioTracks: ep.audioTracks!,
          subtitleTracks: ep.subtitleTracks!,
          mtimeMs: ep.mtimeMs!,
          sizeBytes: ep.sizeBytes!,
          externalIds: ep.externalIds,
          metadata: epMeta,
        })
      }))
    })())
  }

  await Promise.all(tasks.map(p => p.catch(() => {/* non-fatal */})))
  console.log(`Metadata enriched in ${Date.now() - t0}ms (background)`)
}
