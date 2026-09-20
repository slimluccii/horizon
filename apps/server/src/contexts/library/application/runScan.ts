import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { probe } from '../infrastructure/probe/probe.ts'
import { buildCollections } from '../domain/collection.ts'
import { parseIdsFromPath, parseIds, mergeIds } from '../domain/ids.ts'
import { movieId, showId, episodeId } from '../domain/identity.ts'
import { pMap } from './concurrency.ts'
import { walkVideoFiles } from '../infrastructure/fs/walker.ts'
import { discoverSidecarSubtitles, mergeSidecarTracks } from '../infrastructure/fs/sidecars.ts'
import type { MediaRepo, MovieUpsert, EpisodeUpsert } from '../infrastructure/persistence/media.ts'
import type { CollectionsRepo, Collection } from '../infrastructure/persistence/collections.ts'
import type { ActivityBus } from '../../activity/index.ts'

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

function folderYear(name: string): number | null {
  const m = /\((\d{4})\)/.exec(name)
  return m ? parseInt(m[1], 10) : null
}

// media_items holds one file per item, so when several files resolve to the same id the largest one wins.
// The file the item already points at competes too, since a subtree scan does not see it.
async function pickLargestPerId<T extends { id: string; file: string }>(
  candidates: T[],
  media: MediaRepo,
): Promise<{ winners: T[]; keptExisting: string[]; duplicates: string[] }> {
  const byId = new Map<string, T[]>()
  for (const c of candidates) byId.set(c.id, [...(byId.get(c.id) ?? []), c])
  const size = async (file: string) => (await stat(file).catch(() => null))?.size ?? -1
  const winners: T[] = []
  const keptExisting: string[] = []
  const duplicates: string[] = []
  for (const [id, group] of byId) {
    const row = media.getInternalRow(id)
    const current = row && row.deletedAt == null && row.filePath && !group.some(c => c.file === row.filePath)
      ? row.filePath
      : null
    if (group.length === 1 && !current) { winners.push(group[0]); continue }
    const sized = await Promise.all(group.map(async c => ({ c, size: await size(c.file) })))
    sized.sort((a, b) => b.size - a.size || a.c.file.localeCompare(b.c.file))
    if (current && await size(current) > sized[0].size) {
      keptExisting.push(id)
      duplicates.push(...group.map(c => c.file))
      continue
    }
    winners.push(sized[0].c)
    duplicates.push(...sized.slice(1).map(x => x.c.file))
  }
  return { winners, keptExisting, duplicates: duplicates.sort() }
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
): Promise<{ seen: Set<string>; added: number; failed: number; duplicates: string[] }> {
  const seen = new Set<string>()
  let added = 0
  let failed = 0
  const { files } = await walkVideoFiles(pathToScan).catch(() => ({ files: [], dirsSeen: 0 }))
  const matched = files
    .map(file => {
      const base = path.basename(file, path.extname(file))
      const m = MOVIE_RE.exec(base)
      if (!m) return null
      const externalIds = parseIdsFromPath(file)
      const id = movieId({ externalIds, title: m[1].trim(), year: parseInt(m[2], 10) })
      return { file, m, externalIds, id }
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
  const { winners: candidates, keptExisting, duplicates } = await pickLargestPerId(matched, media)
  for (const id of keptExisting) seen.add(id)
  progress.addTotal(candidates.length)

  await pMap(candidates, cfg.scanConcurrency, async ({ file, m, externalIds, id }) => {
    const existed = media.getById(id) !== null
    const p = await probe(file, cfg.cacheDir).catch(() => null)
    if (!p) {
      // A file that is still being written or sits on a sleeping disk fails to probe; that is not a removal.
      if (existed) seen.add(id)
      failed++; progress.tick(); return
    }
    const st = await stat(file).catch(() => null)
    if (!st) { failed++; progress.tick(); return }
    const upsert: MovieUpsert = {
      id,
      filePath: file,
      title: m[1].trim(),
      sortYear: parseInt(m[2], 10),
      durationSec: p.duration,
      resolution: p.resolution,
      videoCodec: p.videoCodec,
      videoBitrate: p.videoBitrate,
      container: p.container,
      hdr: p.hdr,
      audioTracks: p.audioTracks,
      subtitleTracks: mergeSidecarTracks(p.subtitleTracks, await discoverSidecarSubtitles(file)),
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      externalIds,
      metadata: null,
    }
    media.upsertMovie(upsert)
    seen.add(id)
    if (!existed) added++
    bus?.emit({ kind: 'scan:detected', mediaKind: 'movie', title: m[1].trim(), message: `Detected movie "${m[1].trim()}"` })
    progress.tick()
  })
  return { seen, added, failed, duplicates }
}

async function scanShowsPath(
  pathToScan: string,
  cfg: ScanConfig,
  media: MediaRepo,
  progress: ScanProgressReporter,
  bus?: ActivityBus,
): Promise<{ seen: Set<string>; added: number; failed: number; shows: number; episodes: number; duplicates: string[] }> {
  const seen = new Set<string>()
  let added = 0
  let failed = 0

  // Walk every episode file under the path, then group by inferred show dir.
  // No fixed-depth assumption: works whether pathToScan is a library root, a
  // category folder, or a single show directory, and for arbitrary nesting.
  const roots = new Set(cfg.showsRoots ?? [])
  const { files } = await walkVideoFiles(pathToScan).catch(() => ({ files: [], dirsSeen: 0 }))

  type EpCand = { id: string; file: string; base: string; em: RegExpExecArray; showDir: string }
  const matched: EpCand[] = []
  const showIdByDir = new Map<string, string>()
  for (const file of files) {
    const base = path.basename(file)
    const em = EPISODE_RE.exec(base)
    if (!em) continue
    const showDir = showDirForEpisode(file)
    // A loose episode sitting directly in a configured root has no real show
    // folder — skip it rather than naming a show after the root.
    if (roots.has(showDir)) { failed++; continue }
    if (!showIdByDir.has(showDir)) {
      const showName = path.basename(showDir)
      showIdByDir.set(showDir, showId({ externalIds: parseIds(showName), title: cleanTitle(showName), year: folderYear(showName) }))
    }
    const id = episodeId(showIdByDir.get(showDir)!, parseInt(em[1], 10), parseInt(em[2], 10))
    matched.push({ id, file, base, em, showDir })
  }
  const { winners: epCands, keptExisting, duplicates } = await pickLargestPerId(matched, media)
  for (const id of keptExisting) seen.add(id)
  progress.addTotal(epCands.length)

  // One show can span several folders, so upsert once per id, before its episodes.
  const upsertedShows = new Set<string>()
  for (const { showDir } of epCands) {
    const id = showIdByDir.get(showDir)!
    if (upsertedShows.has(id)) continue
    upsertedShows.add(id)
    const showName = path.basename(showDir)
    const existedShow = media.getById(id) !== null
    media.upsertShow({
      id,
      title: cleanTitle(showName),
      sortYear: null,
      externalIds: parseIds(showName),
      metadata: null,
    })
    seen.add(id)
    if (!existedShow) added++
    bus?.emit({ kind: 'scan:detected', mediaKind: 'show', title: cleanTitle(showName), message: `Detected series "${cleanTitle(showName)}"` })
  }

  await pMap(epCands, cfg.scanConcurrency, async ({ id, file, base, em, showDir }) => {
    const parentId = showIdByDir.get(showDir)!
    const showName = path.basename(showDir)
    const existed = media.getById(id) !== null
    const p = await probe(file, cfg.cacheDir).catch(() => null)
    if (!p) {
      // A file that is still being written or sits on a sleeping disk fails to probe; that is not a removal.
      if (existed) seen.add(id)
      failed++; progress.tick(); return
    }
    const st = await stat(file).catch(() => null)
    if (!st) { failed++; progress.tick(); return }
    const insert: EpisodeUpsert = {
      id,
      parentId,
      filePath: file,
      title: episodeTitle(base),
      season: parseInt(em[1], 10),
      episode: parseInt(em[2], 10),
      durationSec: p.duration,
      resolution: p.resolution,
      videoCodec: p.videoCodec,
      videoBitrate: p.videoBitrate,
      container: p.container,
      hdr: p.hdr,
      audioTracks: p.audioTracks,
      subtitleTracks: mergeSidecarTracks(p.subtitleTracks, await discoverSidecarSubtitles(file)),
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

  return { seen, added, failed, shows: upsertedShows.size, episodes: epCands.length, duplicates }
}

// An unmounted Docker bind mount shows up as an empty directory, not as an error.
async function isAvailable(root: string): Promise<boolean> {
  const entries = await readdir(root).catch(() => [])
  return entries.length > 0
}

function isUnder(p: string, root: string): boolean {
  return p === root || p.startsWith(`${root}/`)
}

export interface ScanResult {
  scope: ScanScope
  /** Configured roots that were unreadable or empty; nothing under them was scanned or removed. */
  unavailableRoots: string[]
  /** Files skipped because a larger file resolved to the same item. */
  duplicates: string[]
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
  const duplicates: string[] = []

  const unavailableRoots: string[] = []
  for (const root of [...(cfg.moviesRoots ?? []), ...(cfg.showsRoots ?? [])]) {
    if (await isAvailable(root)) continue
    unavailableRoots.push(root)
    for (const id of deps.media.idsUnder(root)) seen.add(id)
  }
  const scannable = (p: string) => !unavailableRoots.some(root => isUnder(p, root))

  for (const p of scope.moviesPaths.filter(scannable)) {
    const r = await scanMoviesPath(p, cfg, deps.media, progress, deps.bus)
    for (const id of r.seen) seen.add(id)
    added += r.added
    failed += r.failed
    duplicates.push(...r.duplicates)
    movieCount += r.seen.size
  }
  for (const p of scope.showsPaths.filter(scannable)) {
    const r = await scanShowsPath(p, cfg, deps.media, progress, deps.bus)
    for (const id of r.seen) seen.add(id)
    added += r.added
    failed += r.failed
    duplicates.push(...r.duplicates)
    showCount += r.shows
    episodeCount += r.episodes
  }

  let removed = 0
  if (scope.fullScope) {
    removed = deps.media.softDeleteMissing(seen)
  } else {
    for (const p of [...scope.moviesPaths, ...scope.showsPaths].filter(scannable)) {
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
    unavailableRoots,
    duplicates,
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
