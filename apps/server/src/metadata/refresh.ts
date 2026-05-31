import type { MediaRepo, StaleMetadataPick } from '../repos/media.ts'
import type { ChangesCursorRepo } from '../repos/scanState.ts'
import type { TmdbProvider } from './tmdb.ts'

export interface MetadataRefreshConfig {
  /** Per-kind max age before an item is eligible for re-fetch. */
  maxAgeMs: { movie: number; show: number; episode: number }
  /** Base delay before retrying a previously failed item. Doubles per attempt,
   *  capped at `failureBackoffCapMs`. */
  failureBackoffMs: number
  failureBackoffCapMs: number
  /** Max items to refresh per run (across never-fetched + stale-by-age). */
  batchSize: number
  /** Max total items per run when changes-feed pre-population kicks in. */
  changesFeedExtraCap: number
  /** ISO date string for clock-skew-safe "yesterday" if no cursor exists. */
  initialLookbackDays: number
}

export const DEFAULT_REFRESH_CONFIG: MetadataRefreshConfig = {
  maxAgeMs: {
    movie: 30 * 24 * 60 * 60 * 1000,    // 30 d
    show: 7 * 24 * 60 * 60 * 1000,      // 7 d (catches new episode airdates)
    episode: 60 * 24 * 60 * 60 * 1000,  // 60 d (rare to change)
  },
  failureBackoffMs: 60 * 60 * 1000,     // 1 h base; ×2,4,8… up to cap
  failureBackoffCapMs: 30 * 24 * 60 * 60 * 1000, // 30 d
  batchSize: 50,
  changesFeedExtraCap: 200,
  initialLookbackDays: 1,
}

export interface MetadataRefreshDeps {
  media: MediaRepo
  tmdb: TmdbProvider | null
  changesCursor: ChangesCursorRepo
}

/**
 * Live config getter. Called at the START of every `run()` so operator changes
 * to `metadataBatchSize` / `metadataMaxAge*` (via PATCH /settings/server) take
 * effect on the next run with no server restart — matching the thunk pattern
 * documented in CONTEXT.md → ServerSettings (cf. progressRepo's
 * `getWatchedThresholdPct`). A plain `MetadataRefreshConfig` is accepted too
 * (wrapped in a constant thunk) for tests and static callers.
 */
export type MetadataRefreshConfigGetter = () => MetadataRefreshConfig

/** Wrap a static config (or getter) into a getter — keeps existing call sites
 *  that pass a plain config object working unchanged. */
function toConfigGetter(
  cfgOrGetter: MetadataRefreshConfig | MetadataRefreshConfigGetter,
): MetadataRefreshConfigGetter {
  return typeof cfgOrGetter === 'function' ? cfgOrGetter : () => cfgOrGetter
}

export interface RefreshResult {
  refreshed: number
  failed: number
  changesFeedHits: number
  durationMs: number
}

/**
 * Single-flight metadata refresh worker. Two phases per run:
 *   1. Ask TMDB /changes for everything that moved in the cursor window.
 *      Intersect with our DB by tmdb_id and prepend those to the work queue.
 *   2. Fall back to per-kind max-age picks until batch is exhausted.
 *
 * Failed items get exponential backoff to avoid hammering permanent 404s
 * (a row whose tmdb_id was deleted upstream, a wrong match, etc).
 */
export function createMetadataRefreshWorker(
  cfgOrGetter: MetadataRefreshConfig | MetadataRefreshConfigGetter,
  deps: MetadataRefreshDeps,
) {
  // Read live config on each run() — operator settings changes (batchSize,
  // maxAgeMs) apply on the next run without restart. Accepts a plain config
  // object for back-compat (wrapped in a constant thunk).
  const getConfig = toConfigGetter(cfgOrGetter)

  // Mutable reference so `setTmdb` can hot-swap the client on token change.
  let tmdb: TmdbProvider | null = deps.tmdb

  let running = false
  let lastResult: RefreshResult | null = null

  function isoDate(ts: number): string {
    return new Date(ts).toISOString().slice(0, 10)
  }

  async function pullChanges(): Promise<{
    ids: number[]
    windowEnd: number
    succeeded: { movie: boolean; tv: boolean }
  }> {
    const now = Date.now()
    const todayEnd = now
    const movieCursor = deps.changesCursor.get('movie')
    const tvCursor = deps.changesCursor.get('tv')
    const initialLookbackDays = getConfig().initialLookbackDays
    const movieStartTs = movieCursor?.lastWindowEnd ?? (now - initialLookbackDays * 86_400_000)
    const tvStartTs = tvCursor?.lastWindowEnd ?? (now - initialLookbackDays * 86_400_000)
    if (!tmdb) return { ids: [], windowEnd: todayEnd, succeeded: { movie: false, tv: false } }
    // Run both fetches independently. We only advance a kind's cursor when its
    // fetch actually SUCCEEDED — a failure (or empty list from .catch) must not
    // advance the window, or we'd silently skip the items that moved during a
    // failed window. allSettled lets us distinguish success from failure (an
    // empty array is a legitimate success and must not be confused with a
    // failure, which the old `.catch(() => [])` could not tell apart).
    const [movieRes, tvRes] = await Promise.allSettled([
      tmdb.changedMovieIds(isoDate(movieStartTs), isoDate(todayEnd)),
      tmdb.changedShowIds(isoDate(tvStartTs), isoDate(todayEnd)),
    ])
    const movieOk = movieRes.status === 'fulfilled'
    const tvOk = tvRes.status === 'fulfilled'
    const movieIds = movieOk ? movieRes.value : []
    const tvIds = tvOk ? tvRes.value : []
    return {
      ids: [...movieIds, ...tvIds],
      windowEnd: todayEnd,
      succeeded: { movie: movieOk, tv: tvOk },
    }
  }

  /** Convert a TMDB id list to local picks by joining on our tmdb_id column. */
  function changesToPicks(tmdbIds: number[]): StaleMetadataPick[] {
    if (tmdbIds.length === 0) return []
    const out: StaleMetadataPick[] = []
    const seen = new Set<string>()
    for (const tid of tmdbIds) {
      for (const item of deps.media.getByTmdbId(tid)) {
        if (seen.has(item.id)) continue
        seen.add(item.id)
        out.push({
          id: item.id,
          kind: item.kind,
          tmdbId: item.tmdbId,
          externalIds: item.externalIds,
          title: item.title,
          sortYear: item.year,
          parentId: item.parentId,
          season: item.season,
          episode: item.episode,
          metadataFetchedAt: item.metadataFetchedAt,
          metadataFailedCount: item.metadataFailedCount,
        })
      }
    }
    return out
  }

  async function refreshOne(pick: StaleMetadataPick): Promise<boolean> {
    const now = Date.now()
    if (!tmdb) return false
    if (pick.kind === 'movie') {
      let m = pick.tmdbId ? await tmdb.movieByTmdbId(pick.tmdbId) : null
      if (!m && pick.externalIds.tmdb) m = await tmdb.movieByTmdbId(pick.externalIds.tmdb)
      if (!m && pick.externalIds.imdb) m = await tmdb.movieByImdbId(pick.externalIds.imdb)
      if (!m) m = await tmdb.searchMovie(pick.title, pick.sortYear ?? undefined)
      if (!m) { deps.media.markMetadataFailed(pick.id, now); return false }

      const existing = deps.media.getInternalRow(pick.id)
      if (!existing || !existing.filePath) {
        deps.media.markMetadataFailed(pick.id, now)
        return false
      }
      deps.media.upsertMovie({
        id: existing.id,
        filePath: existing.filePath,
        title: existing.title,
        sortYear: existing.year,
        durationSec: existing.durationSec ?? 0,
        resolution: existing.resolution ?? '',
        videoCodec: existing.videoCodec ?? '',
        container: existing.container ?? '',
        hdr: existing.hdr ?? { dv: false, hdr10: false, hdr10plus: false },
        audioTracks: existing.audioTracks ?? [],
        subtitleTracks: existing.subtitleTracks ?? [],
        mtimeMs: existing.mtimeMs ?? 0,
        sizeBytes: existing.sizeBytes ?? 0,
        externalIds: existing.externalIds,
        metadata: m,
      })
      deps.media.markMetadataFetched(pick.id, m.tmdbId ?? null, now)
      return true
    }

    if (pick.kind === 'show') {
      let s = pick.tmdbId ? await tmdb.showByTmdbId(pick.tmdbId) : null
      if (!s && pick.externalIds.tmdb) s = await tmdb.showByTmdbId(pick.externalIds.tmdb)
      if (!s && pick.externalIds.tvdb) s = await tmdb.showByTvdbId(pick.externalIds.tvdb)
      if (!s) s = await tmdb.searchShow(pick.title)
      if (!s) { deps.media.markMetadataFailed(pick.id, now); return false }

      const existing = deps.media.getInternalRow(pick.id)
      if (!existing) { deps.media.markMetadataFailed(pick.id, now); return false }
      deps.media.upsertShow({
        id: existing.id,
        title: existing.title,
        sortYear: existing.year,
        externalIds: existing.externalIds,
        metadata: s,
      })
      deps.media.markMetadataFetched(pick.id, s.tmdbId ?? null, now)
      return true
    }

    // episode
    if (pick.parentId == null || pick.season == null || pick.episode == null) {
      deps.media.markMetadataFailed(pick.id, now)
      return false
    }
    const parent = deps.media.getInternalRow(pick.parentId)
    const parentMeta = parent?.metadata as { tmdbId?: number } | null | undefined
    const showTmdbId: number | undefined =
      parent?.tmdbId
      ?? parentMeta?.tmdbId
      ?? parent?.externalIds.tmdb
    if (!showTmdbId) {
      deps.media.markMetadataFailed(pick.id, now)
      return false
    }
    const ep = await tmdb.episode(showTmdbId, pick.season, pick.episode)
    if (!ep) { deps.media.markMetadataFailed(pick.id, now); return false }

    const existing = deps.media.getInternalRow(pick.id)
    if (!existing || !existing.filePath) {
      deps.media.markMetadataFailed(pick.id, now)
      return false
    }
    deps.media.upsertEpisode({
      id: existing.id,
      parentId: existing.parentId!,
      filePath: existing.filePath,
      title: ep.title ?? existing.title,
      season: existing.season!,
      episode: existing.episode!,
      durationSec: existing.durationSec ?? 0,
      resolution: existing.resolution ?? '',
      videoCodec: existing.videoCodec ?? '',
      container: existing.container ?? '',
      hdr: existing.hdr ?? { dv: false, hdr10: false, hdr10plus: false },
      audioTracks: existing.audioTracks ?? [],
      subtitleTracks: existing.subtitleTracks ?? [],
      mtimeMs: existing.mtimeMs ?? 0,
      sizeBytes: existing.sizeBytes ?? 0,
      externalIds: existing.externalIds,
      metadata: ep,
    })
    deps.media.markMetadataFetched(pick.id, ep.tmdbId ?? null, now)
    return true
  }

  return {
    /**
     * Swap the TMDB client (called on `tmdbToken` settings change).
     * In-flight requests on the old client complete naturally;
     * subsequent calls in the same or future run use the new client.
     */
    setTmdb(provider: TmdbProvider | null): void {
      tmdb = provider
    },

    /**
     * Run one refresh pass. Returns counts; updates cursor + media rows.
     * Concurrent calls coalesce — second caller waits for first to finish
     * and gets the same result (cheap deduplication).
     * Returns early with zero counts if no TMDB client is configured.
     */
    async run(opts: { useChangesFeed: boolean }): Promise<RefreshResult> {
      if (!tmdb) return { refreshed: 0, failed: 0, changesFeedHits: 0, durationMs: 0 }
      if (running) {
        // Wait until current run finishes, return its result.
        while (running) await new Promise(r => setTimeout(r, 50))
        return lastResult ?? { refreshed: 0, failed: 0, changesFeedHits: 0, durationMs: 0 }
      }
      running = true
      const t0 = Date.now()
      let refreshed = 0
      let failed = 0
      let changesFeedHits = 0
      try {
        // Snapshot live config once per run — picks up operator changes to
        // batchSize / maxAgeMs since the previous run, without restart.
        const cfg = getConfig()
        const work: StaleMetadataPick[] = []

        if (opts.useChangesFeed) {
          const now = Date.now()
          const { ids, windowEnd, succeeded } = await pullChanges()
          // Only advance the cursor for kinds whose fetch succeeded; a failed
          // kind keeps its old cursor so the next run re-queries that window.
          if (succeeded.movie) {
            deps.changesCursor.set({ kind: 'movie', lastWindowEnd: windowEnd, lastFetchedAt: now })
          }
          if (succeeded.tv) {
            deps.changesCursor.set({ kind: 'tv', lastWindowEnd: windowEnd, lastFetchedAt: now })
          }
          const picks = changesToPicks(ids)
          changesFeedHits = picks.length
          work.push(...picks.slice(0, cfg.changesFeedExtraCap))
        }

        const stale = deps.media.findStaleMetadata({
          nowMs: Date.now(),
          limit: cfg.batchSize,
          maxAgeMs: cfg.maxAgeMs,
          failureBackoffMs: cfg.failureBackoffMs,
          failureBackoffCap: cfg.failureBackoffCapMs,
        })
        // Dedupe — changes feed may overlap with stale-by-age picks.
        const seenIds = new Set(work.map(p => p.id))
        for (const p of stale) {
          if (seenIds.has(p.id)) continue
          if (work.length >= cfg.batchSize + cfg.changesFeedExtraCap) break
          work.push(p)
        }

        for (const pick of work) {
          const ok = await refreshOne(pick).catch(() => false)
          if (ok) refreshed++ ; else failed++
        }
      } finally {
        const result = { refreshed, failed, changesFeedHits, durationMs: Date.now() - t0 }
        lastResult = result
        running = false
      }
      return lastResult!
    },

    status() {
      return { running, lastResult, configured: tmdb !== null }
    },
  }
}

export type MetadataRefreshWorker = ReturnType<typeof createMetadataRefreshWorker>
