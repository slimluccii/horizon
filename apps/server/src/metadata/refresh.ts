import type { MediaRepo, StaleMetadataPick } from '../repos/media.ts'
import type { ChangesCursorRepo } from '../repos/scanState.ts'
import type { TmdbProvider } from './tmdb.ts'
import type { ActivityBus } from '../activity/bus.ts'
import type { MediaKind } from '@horizon/sdk'

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
  bus?: ActivityBus
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

/**
 * TMDB connectivity error surfaced to operators (issue #64). This is distinct
 * from per-item enrichment failures (tracked via `failed` + markMetadataFailed):
 * `errorState` reflects a failure to reach the TMDB /changes feed itself, which
 * means the cursor was NOT advanced and the window will be retried next run.
 * Held in worker memory only — ephemeral across restarts (see status()).
 */
export interface RefreshErrorState {
  /** Coarse machine-readable code, e.g. 'tmdb-changes-unreachable'. */
  code: string
  /** Human-readable summary (which feeds failed + underlying error message). */
  message: string
  /** Epoch ms of the first run in the current consecutive-failure streak. */
  firstOccurredAt: number
}

export interface RefreshResult {
  refreshed: number
  failed: number
  changesFeedHits: number
  durationMs: number
  /** TMDB-connectivity error from the most recent run, or null on success. */
  errorState: RefreshErrorState | null
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

  const bus = deps.bus
  function step(s: import('@horizon/sdk').MetaStep, kind: MediaKind, title: string, extra?: { tmdbId?: number; reason?: string }) {
    if (!bus) return
    const labels: Record<string, string> = {
      detected: `Detected ${kind} "${title}"`,
      'resolving-show': `Resolving show for "${title}"`,
      searching: `Searching TMDB for "${title}"`,
      matched: `Matched "${title}"${extra?.tmdbId ? ` #${extra.tmdbId}` : ''}`,
      fetching: `Fetching metadata for "${title}"`,
      fetched: `Fetched metadata for "${title}"`,
      stored: `Stored "${title}"`,
      failed: `Failed "${title}"${extra?.reason ? ` (${extra.reason})` : ''}`,
    }
    bus.emit({ kind: 'meta:item', step: s, mediaKind: kind, title, tmdbId: extra?.tmdbId, reason: extra?.reason, message: labels[s] })
  }

  // Mutable reference so `setTmdb` can hot-swap the client on token change.
  let tmdb: TmdbProvider | null = deps.tmdb

  let running = false
  let lastResult: RefreshResult | null = null
  // Sticky TMDB-connectivity error across runs. Set when a /changes fetch fails,
  // cleared when a subsequent changes-feed run succeeds. `firstOccurredAt` is
  // preserved across a failure streak so the UI can say "down since <ts>".
  let errorState: RefreshErrorState | null = null

  function isoDate(ts: number): string {
    return new Date(ts).toISOString().slice(0, 10)
  }

  async function pullChanges(): Promise<{
    ids: number[]
    windowEnd: number
    succeeded: { movie: boolean; tv: boolean }
    failures: { kind: 'movie' | 'tv'; message: string }[]
  }> {
    const now = Date.now()
    const todayEnd = now
    const movieCursor = deps.changesCursor.get('movie')
    const tvCursor = deps.changesCursor.get('tv')
    const initialLookbackDays = getConfig().initialLookbackDays
    const movieStartTs = movieCursor?.lastWindowEnd ?? (now - initialLookbackDays * 86_400_000)
    const tvStartTs = tvCursor?.lastWindowEnd ?? (now - initialLookbackDays * 86_400_000)
    if (!tmdb) return { ids: [], windowEnd: todayEnd, succeeded: { movie: false, tv: false }, failures: [] }
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
    const failures: { kind: 'movie' | 'tv'; message: string }[] = []
    if (!movieOk) failures.push({ kind: 'movie', message: reasonMessage(movieRes.reason) })
    if (!tvOk) failures.push({ kind: 'tv', message: reasonMessage(tvRes.reason) })
    return {
      ids: [...movieIds, ...tvIds],
      windowEnd: todayEnd,
      succeeded: { movie: movieOk, tv: tvOk },
      failures,
    }
  }

  function reasonMessage(reason: unknown): string {
    if (reason instanceof Error) return reason.message
    return String(reason)
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
      step('detected', 'movie', pick.title)
      let m = pick.tmdbId ? await tmdb.movieByTmdbId(pick.tmdbId) : null
      if (!m && pick.externalIds.tmdb) m = await tmdb.movieByTmdbId(pick.externalIds.tmdb)
      if (!m && pick.externalIds.imdb) m = await tmdb.movieByImdbId(pick.externalIds.imdb)
      if (!m) { step('searching', 'movie', pick.title); m = await tmdb.searchMovie(pick.title, pick.sortYear ?? undefined) }
      if (!m) { step('failed', 'movie', pick.title, { reason: 'no-match' }); deps.media.markMetadataFailed(pick.id, now); return false }
      step('matched', 'movie', pick.title, { tmdbId: m.tmdbId })
      step('fetching', 'movie', pick.title, { tmdbId: m.tmdbId })

      const existing = deps.media.getInternalRow(pick.id)
      if (!existing || !existing.filePath) {
        step('failed', 'movie', pick.title, { reason: 'no-file' })
        deps.media.markMetadataFailed(pick.id, now)
        return false
      }
      step('fetched', 'movie', pick.title, { tmdbId: m.tmdbId })
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
      step('stored', 'movie', pick.title, { tmdbId: m.tmdbId })
      return true
    }

    if (pick.kind === 'show') {
      step('detected', 'show', pick.title)
      let s = pick.tmdbId ? await tmdb.showByTmdbId(pick.tmdbId) : null
      if (!s && pick.externalIds.tmdb) s = await tmdb.showByTmdbId(pick.externalIds.tmdb)
      if (!s && pick.externalIds.tvdb) s = await tmdb.showByTvdbId(pick.externalIds.tvdb)
      if (!s) { step('searching', 'show', pick.title); s = await tmdb.searchShow(pick.title) }
      if (!s) { step('failed', 'show', pick.title, { reason: 'no-match' }); deps.media.markMetadataFailed(pick.id, now); return false }
      step('matched', 'show', pick.title, { tmdbId: s.tmdbId })
      step('fetching', 'show', pick.title, { tmdbId: s.tmdbId })

      const existing = deps.media.getInternalRow(pick.id)
      if (!existing) { step('failed', 'show', pick.title, { reason: 'no-file' }); deps.media.markMetadataFailed(pick.id, now); return false }
      step('fetched', 'show', pick.title, { tmdbId: s.tmdbId })
      deps.media.upsertShow({
        id: existing.id,
        title: existing.title,
        sortYear: existing.year,
        externalIds: existing.externalIds,
        metadata: s,
      })
      deps.media.markMetadataFetched(pick.id, s.tmdbId ?? null, now)
      step('stored', 'show', pick.title, { tmdbId: s.tmdbId })
      return true
    }

    // episode
    step('detected', 'episode', pick.title)
    if (pick.parentId == null || pick.season == null || pick.episode == null) {
      step('failed', 'episode', pick.title, { reason: 'no-show' })
      deps.media.markMetadataFailed(pick.id, now)
      return false
    }
    step('resolving-show', 'episode', pick.title)
    const parent = deps.media.getInternalRow(pick.parentId)
    const parentMeta = parent?.metadata as { tmdbId?: number } | null | undefined
    const showTmdbId: number | undefined =
      parent?.tmdbId
      ?? parentMeta?.tmdbId
      ?? parent?.externalIds.tmdb
    if (!showTmdbId) {
      step('failed', 'episode', pick.title, { reason: 'no-show' })
      deps.media.markMetadataFailed(pick.id, now)
      return false
    }
    step('matched', 'episode', pick.title, { tmdbId: showTmdbId })
    step('fetching', 'episode', pick.title, { tmdbId: showTmdbId })
    const ep = await tmdb.episode(showTmdbId, pick.season, pick.episode)
    if (!ep) { step('failed', 'episode', pick.title, { reason: 'no-match' }); deps.media.markMetadataFailed(pick.id, now); return false }

    const existing = deps.media.getInternalRow(pick.id)
    if (!existing || !existing.filePath) {
      step('failed', 'episode', pick.title, { reason: 'no-file' })
      deps.media.markMetadataFailed(pick.id, now)
      return false
    }
    step('fetched', 'episode', pick.title, { tmdbId: showTmdbId })
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
    step('stored', 'episode', pick.title, { tmdbId: showTmdbId })
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
     * Run a refresh pass. Returns counts; updates cursor + media rows.
     * Concurrent calls coalesce — second caller waits for first to finish
     * and gets the same result (cheap deduplication).
     * Returns early with zero counts if no TMDB client is configured.
     *
     * `drain` (post-scan first-import): after the changes-feed phase, keep
     * pulling batchSize-sized batches of stale/never-fetched items and enriching
     * them until the queue is dry — so a fresh library gets FULL metadata in one
     * pass instead of `batchSize` items per trigger. Calls stay serial (the
     * provider's own concurrency cap applies); backoff still excludes
     * permanently-failing items, so the loop terminates. Without `drain` the
     * behaviour is unchanged: a single batchSize batch.
     */
    async run(opts: { useChangesFeed: boolean; drain?: boolean }): Promise<RefreshResult> {
      if (!tmdb) return { refreshed: 0, failed: 0, changesFeedHits: 0, durationMs: 0, errorState: null }
      if (running) {
        // Wait until current run finishes, return its result.
        while (running) await new Promise(r => setTimeout(r, 50))
        return lastResult ?? { refreshed: 0, failed: 0, changesFeedHits: 0, durationMs: 0, errorState }
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
          const { ids, windowEnd, succeeded, failures } = await pullChanges()
          // Only advance the cursor for kinds whose fetch succeeded; a failed
          // kind keeps its old cursor so the next run re-queries that window.
          if (succeeded.movie) {
            deps.changesCursor.set({ kind: 'movie', lastWindowEnd: windowEnd, lastFetchedAt: now })
          }
          if (succeeded.tv) {
            deps.changesCursor.set({ kind: 'tv', lastWindowEnd: windowEnd, lastFetchedAt: now })
          }
          // Surface TMDB connectivity errors (issue #64). On any failed kind,
          // set a sticky errorState (preserving firstOccurredAt across a streak)
          // and log with recovery guidance. When both kinds succeed, clear it.
          if (failures.length > 0) {
            const message = failures.map(f => `${f.kind} changes failed: ${f.message}`).join('; ')
            errorState = {
              code: 'tmdb-changes-unreachable',
              message,
              firstOccurredAt: errorState?.firstOccurredAt ?? now,
            }
            console.error(
              `[metadata-refresh] TMDB /changes fetch failed (${message}). ` +
              `Cursor not advanced — window will be retried next run. ` +
              `Check tmdb_token in ServerSettings and TMDB availability.`,
            )
          } else {
            errorState = null
          }
          const picks = changesToPicks(ids)
          changesFeedHits = picks.length
          work.push(...picks.slice(0, cfg.changesFeedExtraCap))
        }

        // First pass: changes-feed picks (already in `work`) + one batch of
        // stale/never-fetched, deduped against the changes picks.
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

        if (work.length > 0) bus?.emit({ kind: 'meta:start', message: 'Metadata refresh started' })

        for (const pick of work) {
          const ok = await refreshOne(pick).catch(() => false)
          if (ok) refreshed++ ; else failed++
        }

        // Drain mode (post-scan): keep pulling fresh batches until the queue is
        // dry. findStaleMetadata's failure-backoff guard excludes items we just
        // marked failed, so each batch shrinks and the loop terminates. Bounded
        // by a generous safety cap so a pathological state can't spin forever.
        if (opts.drain) {
          const MAX_DRAIN_BATCHES = 10_000
          for (let b = 0; b < MAX_DRAIN_BATCHES; b++) {
            const batch = deps.media.findStaleMetadata({
              nowMs: Date.now(),
              limit: cfg.batchSize,
              maxAgeMs: cfg.maxAgeMs,
              failureBackoffMs: cfg.failureBackoffMs,
              failureBackoffCap: cfg.failureBackoffCapMs,
            })
            if (batch.length === 0) break
            let batchProgress = 0
            for (const pick of batch) {
              const ok = await refreshOne(pick).catch(() => false)
              if (ok) { refreshed++; batchProgress++ } else { failed++ }
            }
            // If a full batch came back but none succeeded, every item is now in
            // backoff (or permanently failing) — the next query would return the
            // same rows. Stop to avoid a tight loop.
            if (batchProgress === 0) break
          }
        }
      } finally {
        const result = { refreshed, failed, changesFeedHits, durationMs: Date.now() - t0, errorState }
        lastResult = result
        running = false
        bus?.emit({ kind: 'meta:done', refreshed, failed, durationMs: result.durationMs, message: `Metadata refresh done · ${refreshed} ok, ${failed} failed` })
      }
      return lastResult!
    },

    status() {
      return { running, lastResult, configured: tmdb !== null, errorState }
    },
  }
}

export type MetadataRefreshWorker = ReturnType<typeof createMetadataRefreshWorker>
