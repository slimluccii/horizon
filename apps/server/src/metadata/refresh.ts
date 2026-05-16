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
  tmdb: TmdbProvider
  changesCursor: ChangesCursorRepo
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
  cfg: MetadataRefreshConfig,
  deps: MetadataRefreshDeps,
) {
  let running = false
  let lastResult: RefreshResult | null = null

  function isoDate(ts: number): string {
    return new Date(ts).toISOString().slice(0, 10)
  }

  async function pullChanges(): Promise<{ ids: number[]; windowEnd: number }> {
    const now = Date.now()
    const todayEnd = now
    const movieCursor = deps.changesCursor.get('movie')
    const tvCursor = deps.changesCursor.get('tv')
    const movieStartTs = movieCursor?.lastWindowEnd ?? (now - cfg.initialLookbackDays * 86_400_000)
    const tvStartTs = tvCursor?.lastWindowEnd ?? (now - cfg.initialLookbackDays * 86_400_000)
    const movieIds = await deps.tmdb.changedMovieIds(isoDate(movieStartTs), isoDate(todayEnd))
      .catch(() => [])
    const tvIds = await deps.tmdb.changedShowIds(isoDate(tvStartTs), isoDate(todayEnd))
      .catch(() => [])
    deps.changesCursor.set({ kind: 'movie', lastWindowEnd: todayEnd, lastFetchedAt: now })
    deps.changesCursor.set({ kind: 'tv', lastWindowEnd: todayEnd, lastFetchedAt: now })
    return { ids: [...movieIds, ...tvIds], windowEnd: todayEnd }
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
    if (pick.kind === 'movie') {
      let m = pick.tmdbId ? await deps.tmdb.movieByTmdbId(pick.tmdbId) : null
      if (!m && pick.externalIds.tmdb) m = await deps.tmdb.movieByTmdbId(pick.externalIds.tmdb)
      if (!m && pick.externalIds.imdb) m = await deps.tmdb.movieByImdbId(pick.externalIds.imdb)
      if (!m) m = await deps.tmdb.searchMovie(pick.title, pick.sortYear ?? undefined)
      if (!m) { deps.media.markMetadataFailed(pick.id, now); return false }

      const existing = deps.media.getInternal(pick.id)
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
      let s = pick.tmdbId ? await deps.tmdb.showByTmdbId(pick.tmdbId) : null
      if (!s && pick.externalIds.tmdb) s = await deps.tmdb.showByTmdbId(pick.externalIds.tmdb)
      if (!s && pick.externalIds.tvdb) s = await deps.tmdb.showByTvdbId(pick.externalIds.tvdb)
      if (!s) s = await deps.tmdb.searchShow(pick.title)
      if (!s) { deps.media.markMetadataFailed(pick.id, now); return false }

      const existing = deps.media.getInternal(pick.id)
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
    const parent = deps.media.getInternal(pick.parentId)
    const parentMeta = parent?.metadata as { tmdbId?: number } | null | undefined
    const showTmdbId: number | undefined =
      parent?.tmdbId
      ?? parentMeta?.tmdbId
      ?? parent?.externalIds.tmdb
    if (!showTmdbId) {
      deps.media.markMetadataFailed(pick.id, now)
      return false
    }
    const ep = await deps.tmdb.episode(showTmdbId, pick.season, pick.episode)
    if (!ep) { deps.media.markMetadataFailed(pick.id, now); return false }

    const existing = deps.media.getInternal(pick.id)
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
     * Run one refresh pass. Returns counts; updates cursor + media rows.
     * Concurrent calls coalesce — second caller waits for first to finish
     * and gets the same result (cheap deduplication).
     */
    async run(opts: { useChangesFeed: boolean }): Promise<RefreshResult> {
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
        const work: StaleMetadataPick[] = []

        if (opts.useChangesFeed) {
          const { ids } = await pullChanges()
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
      return { running, lastResult }
    },
  }
}

export type MetadataRefreshWorker = ReturnType<typeof createMetadataRefreshWorker>
