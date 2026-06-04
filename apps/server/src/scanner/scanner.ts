import { stat } from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { probe } from './probe.ts'
import { buildCollections } from './collections.ts'
import { parseIdsFromPath, parseIds, mergeIds } from './ids.ts'
import { pMap } from './concurrency.ts'
import { walkVideoFiles } from './walker.ts'
import type { MediaRepo, MovieUpsert, EpisodeUpsert } from '../repos/media.ts'
import type { CollectionsRepo, Collection } from '../repos/collections.ts'
import type { ActivityBus } from '../activity/bus.ts'

export interface ScanConfig {
  /** Library roots. Optional on the base config because they're now runtime-
   *  settable (serverSettings) rather than from env Config — the ScanManager
   *  overlays the live values via deps.getRoots before calling fullScope /
   *  classifyPath. Default to [] when absent. */
  moviesRoots?: string[]
  showsRoots?: string[]
  cacheDir: string
  scanConcurrency: number
}

export interface ScanDeps {
  media: MediaRepo
  collections: CollectionsRepo
  bus?: ActivityBus
}

/** Live progress sink. `addTotal` is called once per scanned path after its
 *  (cheap) file walk discovers how many probe-able items it holds; `tick` is
 *  called once per item as it finishes (success or fail). Lets the UI show a
 *  "scanned X of Y" bar — Y grows as roots are walked, then stabilises. */
export interface ScanProgressReporter {
  addTotal(n: number): void
  tick(): void
}

const NOOP_PROGRESS: ScanProgressReporter = { addTotal() {}, tick() {} }

export interface ScanCounts {
  /** Ids of media rows touched (movies + shows + episodes). Caller may use
   *  this for soft-delete reconciliation. */
  seen: Set<string>
  /** Rows that were inserted (didn't exist before). */
  added: number
  /** Files visited that didn't probe successfully. */
  failed: number
  /** Wall time of the scan in ms. */
  durationMs: number
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

/** Season-folder names to skip when inferring a show directory:
 *  "Season 01", "Season 1", "Series 1", "Specials", "S01", "S1". */
const SEASON_DIR_RE = /^(?:season|series|specials)\b|^s\d{1,2}$/i

/** Infer the show directory for an episode file. The show is the file's parent
 *  unless that parent is a season folder, in which case it's the grandparent.
 *  This is independent of how deep the show sits below the library root, so
 *  category/wrapper folders (tv/, anime/, A-D/) never become shows. */
function showDirForEpisode(file: string): string {
  const parent = path.dirname(file)
  if (SEASON_DIR_RE.test(path.basename(parent))) return path.dirname(parent)
  return parent
}

export interface ScanScope {
  /** Sub-paths to walk for movies (each must lie under one of cfg.moviesRoots). */
  moviesPaths: string[]
  /** Sub-paths to walk for shows (each must lie under one of cfg.showsRoots). */
  showsPaths: string[]
  /** Iff true, called with all roots — enables soft-delete of any missing row.
   *  When false (subtree scan), soft-delete is scoped to each path prefix. */
  fullScope: boolean
}

/** Build a scope for a "full" scan covering every configured root. */
export function fullScope(cfg: ScanConfig): ScanScope {
  return {
    moviesPaths: [...(cfg.moviesRoots ?? [])],
    showsPaths: [...(cfg.showsRoots ?? [])],
    fullScope: true,
  }
}

/** Decide whether a subtree path is under a movies root or a shows root.
 *  Returns null if the path doesn't match any configured root. */
export function classifyPath(p: string, cfg: ScanConfig): 'movies' | 'shows' | null {
  for (const r of cfg.moviesRoots ?? []) if (p === r || p.startsWith(`${r}/`)) return 'movies'
  for (const r of cfg.showsRoots ?? []) if (p === r || p.startsWith(`${r}/`)) return 'shows'
  return null
}

async function scanMoviesPath(
  pathToScan: string,
  cfg: ScanConfig,
  media: MediaRepo,
  progress: ScanProgressReporter,
  bus?: ActivityBus,
): Promise<{ seen: Set<string>; added: number; failed: number }> {
  const seen = new Set<string>()
  let added = 0
  let failed = 0
  const { files } = await walkVideoFiles(pathToScan).catch(() => ({ files: [], dirsSeen: 0 }))
  const candidates = files
    .map(file => {
      const base = path.basename(file, path.extname(file))
      const m = MOVIE_RE.exec(base)
      return m ? { file, base, m } : null
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
  progress.addTotal(candidates.length)

  await pMap(candidates, cfg.scanConcurrency, async ({ file, m }) => {
    const p = await probe(file, cfg.cacheDir).catch(() => null)
    if (!p) { failed++; progress.tick(); return }
    const st = await stat(file).catch(() => null)
    if (!st) { failed++; progress.tick(); return }
    const id = hashId(file)
    const existed = media.getById(id) !== null
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
    if (!existed) added++
    bus?.emit({ kind: 'scan:detected', mediaKind: 'movie', title: m[1].trim(), message: `Detected movie "${m[1].trim()}"` })
    progress.tick()
  })
  return { seen, added, failed }
}

async function scanShowsPath(
  pathToScan: string,
  cfg: ScanConfig,
  media: MediaRepo,
  progress: ScanProgressReporter,
  bus?: ActivityBus,
): Promise<{ seen: Set<string>; added: number; failed: number; shows: number; episodes: number }> {
  const seen = new Set<string>()
  let added = 0
  let failed = 0

  // Walk every episode file under the path, then group by inferred show dir.
  // No fixed-depth assumption: works whether pathToScan is a library root, a
  // category folder, or a single show directory, and for arbitrary nesting.
  const roots = new Set(cfg.showsRoots ?? [])
  const { files } = await walkVideoFiles(pathToScan).catch(() => ({ files: [], dirsSeen: 0 }))

  type EpCand = { file: string; base: string; em: RegExpExecArray; showDir: string }
  const epCands: EpCand[] = []
  for (const file of files) {
    const base = path.basename(file)
    const em = EPISODE_RE.exec(base)
    if (!em) continue
    const showDir = showDirForEpisode(file)
    // A loose episode sitting directly in a configured root has no real show
    // folder — skip it rather than naming a show after the root.
    if (roots.has(showDir)) { failed++; continue }
    epCands.push({ file, base, em, showDir })
  }
  progress.addTotal(epCands.length)

  // Upsert one show per distinct showDir before its episodes.
  const showIdByDir = new Map<string, string>()
  for (const { showDir } of epCands) {
    if (showIdByDir.has(showDir)) continue
    const showName = path.basename(showDir)
    const showId = hashId(showDir)
    showIdByDir.set(showDir, showId)
    const existedShow = media.getById(showId) !== null
    media.upsertShow({
      id: showId,
      title: cleanTitle(showName),
      sortYear: null,
      externalIds: parseIds(showName),
      metadata: null,
    })
    seen.add(showId)
    if (!existedShow) added++
    bus?.emit({ kind: 'scan:detected', mediaKind: 'show', title: cleanTitle(showName), message: `Detected series "${cleanTitle(showName)}"` })
  }

  await pMap(epCands, cfg.scanConcurrency, async ({ file, base, em, showDir }) => {
    const showId = showIdByDir.get(showDir)!
    const showName = path.basename(showDir)
    const p = await probe(file, cfg.cacheDir).catch(() => null)
    if (!p) { failed++; progress.tick(); return }
    const st = await stat(file).catch(() => null)
    if (!st) { failed++; progress.tick(); return }
    const id = hashId(file)
    const existed = media.getById(id) !== null
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
      externalIds: mergeIds(parseIds(showName), parseIds(base)),
      metadata: null,
    }
    media.upsertEpisode(insert)
    seen.add(id)
    if (!existed) added++
    progress.tick()
  })

  return { seen, added, failed, shows: showIdByDir.size, episodes: epCands.length }
}

export interface ScanResult {
  scope: ScanScope
  itemsSeen: number
  itemsAdded: number
  itemsRemoved: number
  itemsFailed: number
  durationMs: number
  movies: number
  shows: number
  episodes: number
}

/**
 * Run a scan for the given scope. For full scope, soft-deletes any missing row
 * across the library. For subtree scope, soft-deletes only rows whose file_path
 * is under one of the scanned subtrees.
 *
 * Idempotent: existing rows are upserted, ffprobe results are cache-served.
 */
export async function runScan(
  scope: ScanScope,
  cfg: ScanConfig,
  deps: ScanDeps,
  progress: ScanProgressReporter = NOOP_PROGRESS,
): Promise<ScanResult> {
  const t0 = Date.now()
  const seen = new Set<string>()
  let added = 0
  let failed = 0
  let movieCount = 0
  let showCount = 0
  let episodeCount = 0

  for (const p of scope.moviesPaths) {
    const r = await scanMoviesPath(p, cfg, deps.media, progress, deps.bus)
    for (const id of r.seen) seen.add(id)
    added += r.added
    failed += r.failed
    movieCount += r.seen.size
  }
  for (const p of scope.showsPaths) {
    const r = await scanShowsPath(p, cfg, deps.media, progress, deps.bus)
    for (const id of r.seen) seen.add(id)
    added += r.added
    failed += r.failed
    showCount += r.shows
    episodeCount += r.episodes
  }

  let removed = 0
  if (scope.fullScope) {
    removed = deps.media.softDeleteMissing(seen)
  } else {
    for (const p of [...scope.moviesPaths, ...scope.showsPaths]) {
      removed += deps.media.softDeleteMissingUnder(p, seen)
    }
  }

  // Collections are derived from full library state. Only rebuild on full scope —
  // a subtree change might add/remove a movie that joins/leaves a collection,
  // but rebuilding is cheap so do it on every scan.
  const movies = deps.media.listMovies()
  const collections: Collection[] = buildCollections(movies).map(c => ({
    id: c.id,
    name: c.name,
    tmdbId: c.tmdbId,
    posterPath: c.posterPath,
    backdropPath: c.backdropPath,
    movieIds: c.movieIds,
  }))
  deps.collections.replaceAll(collections)

  return {
    scope,
    itemsSeen: seen.size,
    itemsAdded: added,
    itemsRemoved: removed,
    itemsFailed: failed,
    durationMs: Date.now() - t0,
    movies: movieCount,
    shows: showCount,
    episodes: episodeCount,
  }
}

/**
 * Backwards-compat wrapper used by tests that still call the old API.
 * New code should call `runScan(fullScope(cfg), cfg, deps)` via ScanManager.
 */
export async function rescan(
  cfg: ScanConfig,
  deps: ScanDeps & { tmdb?: unknown },
): Promise<void> {
  const r = await runScan(fullScope(cfg), cfg, deps)
  console.log(
    `Library: ${deps.media.listMovies().length} movies, ${deps.media.listShows().length} shows ` +
    `(scan ${r.durationMs}ms, +${r.itemsAdded} -${r.itemsRemoved})`,
  )
}
