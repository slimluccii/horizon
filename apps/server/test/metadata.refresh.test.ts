import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type DatabaseSync } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createMediaRepo, type MediaRepo } from '../src/repos/media.ts'
import { createChangesCursorRepo } from '../src/repos/scanState.ts'
import { createMetadataRefreshWorker, DEFAULT_REFRESH_CONFIG } from '../src/metadata/refresh.ts'
import type { TmdbProvider } from '../src/metadata/tmdb.ts'

let db: DatabaseSync
let media: MediaRepo

function seedMovie(id: string, opts: Partial<{
  metadataFetchedAt: number | null
  failedCount: number
  failedAt: number | null
  tmdbId: number | null
}> = {}) {
  // Insert a bare row directly — bypass repo for test brevity.
  db.prepare(
    `INSERT INTO media_items (id, kind, title, file_path, mtime_ms, size_bytes,
                              first_seen_at, last_seen_at,
                              metadata_fetched_at, metadata_failed_at,
                              metadata_failed_count, tmdb_id)
     VALUES (?, 'movie', ?, ?, 0, 0, 0, 0, ?, ?, ?, ?)`,
  ).run(
    id, `Title ${id}`, `/movies/${id}.mkv`,
    opts.metadataFetchedAt ?? null,
    opts.failedAt ?? null,
    opts.failedCount ?? 0,
    opts.tmdbId ?? null,
  )
}

beforeEach(() => {
  db = openDatabase(':memory:')
  migrate(db)
  media = createMediaRepo(db)
})

describe('findStaleMetadata', () => {
  const baseOpts = {
    nowMs: 1_000_000_000,
    limit: 10,
    maxAgeMs: { movie: 1000, show: 1000, episode: 1000 },
    failureBackoffMs: 100,
    failureBackoffCap: 10_000,
  }

  it('prioritizes never-fetched items', () => {
    seedMovie('a', { metadataFetchedAt: 999_999_500 })       // fresh, < 1s old
    seedMovie('b', { metadataFetchedAt: null })              // never
    seedMovie('c', { metadataFetchedAt: 999_998_000 })       // 2s old (stale)
    const picks = media.findStaleMetadata(baseOpts)
    expect(picks[0].id).toBe('b')                             // never-fetched first
    expect(picks.map(p => p.id)).toContain('c')
    expect(picks.map(p => p.id)).not.toContain('a')           // not stale
  })

  it('respects exponential failure backoff', () => {
    // Failed once at now-50ms; backoff = 100ms × 2^1 = 200ms; not yet eligible.
    seedMovie('a', { metadataFetchedAt: null, failedCount: 1, failedAt: 999_999_950 })
    const picks = media.findStaleMetadata(baseOpts)
    expect(picks.find(p => p.id === 'a')).toBeUndefined()

    // Same item, failure was long ago → eligible again.
    db.prepare('UPDATE media_items SET metadata_failed_at = ? WHERE id = ?').run(999_999_000, 'a')
    const picks2 = media.findStaleMetadata(baseOpts)
    expect(picks2.find(p => p.id === 'a')).toBeDefined()
  })

  it('respects limit', () => {
    for (let i = 0; i < 20; i++) seedMovie(`m${i}`)
    const picks = media.findStaleMetadata({ ...baseOpts, limit: 5 })
    expect(picks.length).toBe(5)
  })
})

describe('MetadataRefreshWorker', () => {
  function fakeTmdb(): TmdbProvider {
    let movieCalls = 0
    return {
      async movieByTmdbId(id: number) {
        movieCalls++
        return { kind: 'movie', tmdbId: id, title: `Movie ${id}` } as any
      },
      async movieByImdbId() { return null },
      async searchMovie() { return null },
      async showByTmdbId() { return null },
      async showByTvdbId() { return null },
      async searchShow() { return null },
      async episode() { return null },
      async changedMovieIds(start: string, end: string) {
        if (start && end) return [42]
        return []
      },
      async changedShowIds() { return [] },
      // expose call count via a custom prop for the test
      get _movieCalls() { return movieCalls },
    } as any
  }

  it('runs picks through TMDB and marks fetched', async () => {
    seedMovie('a', { tmdbId: 7 })
    const tmdb = fakeTmdb()
    const worker = createMetadataRefreshWorker(
      { ...DEFAULT_REFRESH_CONFIG, batchSize: 5, changesFeedExtraCap: 5 },
      { media, tmdb, changesCursor: createChangesCursorRepo(db) },
    )
    const r = await worker.run({ useChangesFeed: false })
    expect(r.refreshed).toBe(1)
    expect(r.failed).toBe(0)
    const item = db.prepare('SELECT metadata_fetched_at FROM media_items WHERE id = ?').get('a') as any
    expect(item.metadata_fetched_at).not.toBeNull()
  })

  it('changes feed populates extra picks', async () => {
    // Item with tmdb_id=42 — matches the fake changes feed.
    seedMovie('a', { tmdbId: 42, metadataFetchedAt: 1 })
    const tmdb = fakeTmdb()
    const worker = createMetadataRefreshWorker(
      { ...DEFAULT_REFRESH_CONFIG, batchSize: 5, changesFeedExtraCap: 5 },
      { media, tmdb, changesCursor: createChangesCursorRepo(db) },
    )
    const r = await worker.run({ useChangesFeed: true })
    expect(r.changesFeedHits).toBe(1)
    expect(r.refreshed).toBe(1)
  })

  it('coalesces concurrent run calls', async () => {
    seedMovie('a', { tmdbId: 7 })
    const tmdb = fakeTmdb()
    const worker = createMetadataRefreshWorker(
      { ...DEFAULT_REFRESH_CONFIG, batchSize: 5, changesFeedExtraCap: 5 },
      { media, tmdb, changesCursor: createChangesCursorRepo(db) },
    )
    const [r1, r2] = await Promise.all([
      worker.run({ useChangesFeed: false }),
      worker.run({ useChangesFeed: false }),
    ])
    // Both calls should resolve with the same result object (coalesced).
    expect(r1.refreshed + r2.refreshed).toBeGreaterThanOrEqual(1)
    expect((tmdb as any)._movieCalls).toBe(1)                 // de-duplicated
  })

  describe('live config getter (#61 / #65)', () => {
    it('reads batchSize live on each run — a smaller batchSize limits refresh count', async () => {
      for (let i = 0; i < 10; i++) seedMovie(`m${i}`, { tmdbId: 100 + i })
      const tmdb = fakeTmdb()
      // Mutable config the getter reads live, simulating serverSettings.
      let liveBatchSize = 10
      const worker = createMetadataRefreshWorker(
        () => ({ ...DEFAULT_REFRESH_CONFIG, changesFeedExtraCap: 0, batchSize: liveBatchSize }),
        { media, tmdb, changesCursor: createChangesCursorRepo(db) },
      )
      const first = await worker.run({ useChangesFeed: false })
      expect(first.refreshed).toBe(10)

      // Re-stale everything, then shrink the batch size — next run must honor it.
      db.prepare('UPDATE media_items SET metadata_fetched_at = NULL').run()
      liveBatchSize = 3
      const second = await worker.run({ useChangesFeed: false })
      expect(second.refreshed).toBe(3)
    })

    it('reads maxAgeMs live on each run', async () => {
      const now = Date.now()
      // Fetched 5 days ago.
      seedMovie('a', { tmdbId: 7, metadataFetchedAt: now - 5 * 86_400_000 })
      const tmdb = fakeTmdb()
      let movieMaxAgeMs = 30 * 86_400_000 // 30d — item is NOT stale
      const worker = createMetadataRefreshWorker(
        () => ({
          ...DEFAULT_REFRESH_CONFIG,
          changesFeedExtraCap: 0,
          batchSize: 50,
          maxAgeMs: { movie: movieMaxAgeMs, show: movieMaxAgeMs, episode: movieMaxAgeMs },
        }),
        { media, tmdb, changesCursor: createChangesCursorRepo(db) },
      )
      const first = await worker.run({ useChangesFeed: false })
      expect(first.refreshed).toBe(0) // not yet stale at 30d threshold

      // Tighten the window to 1 day — the 5-day-old item becomes stale.
      movieMaxAgeMs = 1 * 86_400_000
      const second = await worker.run({ useChangesFeed: false })
      expect(second.refreshed).toBe(1)
    })

    it('still accepts a plain static config object (back-compat)', async () => {
      seedMovie('a', { tmdbId: 7 })
      const tmdb = fakeTmdb()
      const worker = createMetadataRefreshWorker(
        { ...DEFAULT_REFRESH_CONFIG, batchSize: 5, changesFeedExtraCap: 0 },
        { media, tmdb, changesCursor: createChangesCursorRepo(db) },
      )
      const r = await worker.run({ useChangesFeed: false })
      expect(r.refreshed).toBe(1)
    })
  })

  describe('changes-feed cursor advances only on successful fetch (#49)', () => {
    it('does not advance movie cursor if movie fetch fails but tv succeeds', async () => {
      seedMovie('a', { tmdbId: 42, metadataFetchedAt: 1 })
      const tmdb = {
        ...fakeTmdb(),
        async changedMovieIds() { throw new Error('network down') },
        async changedShowIds() { return [42] },
      } as any
      const cursor = createChangesCursorRepo(db)
      const worker = createMetadataRefreshWorker(
        { ...DEFAULT_REFRESH_CONFIG, batchSize: 5, changesFeedExtraCap: 5 },
        { media, tmdb, changesCursor: cursor },
      )
      await worker.run({ useChangesFeed: true })
      // Movie fetch threw → cursor must stay null (window re-queried next run).
      expect(cursor.get('movie')).toBeNull()
      // TV fetch succeeded → cursor advanced.
      expect(cursor.get('tv')).not.toBeNull()
      expect(cursor.get('tv')!.lastWindowEnd).toBeGreaterThan(0)
    })

    it('does not advance any cursor if both changes fetches fail', async () => {
      seedMovie('a', { tmdbId: 42, metadataFetchedAt: 1 })
      const tmdb = {
        ...fakeTmdb(),
        async changedMovieIds() { throw new Error('movie down') },
        async changedShowIds() { throw new Error('tv down') },
      } as any
      const cursor = createChangesCursorRepo(db)
      const worker = createMetadataRefreshWorker(
        { ...DEFAULT_REFRESH_CONFIG, batchSize: 5, changesFeedExtraCap: 5 },
        { media, tmdb, changesCursor: cursor },
      )
      await worker.run({ useChangesFeed: true })
      expect(cursor.get('movie')).toBeNull()
      expect(cursor.get('tv')).toBeNull()
    })

    it('advances both cursors when both fetches succeed', async () => {
      seedMovie('a', { tmdbId: 42, metadataFetchedAt: 1 })
      const tmdb = fakeTmdb()
      const cursor = createChangesCursorRepo(db)
      const worker = createMetadataRefreshWorker(
        { ...DEFAULT_REFRESH_CONFIG, batchSize: 5, changesFeedExtraCap: 5 },
        { media, tmdb, changesCursor: cursor },
      )
      await worker.run({ useChangesFeed: true })
      expect(cursor.get('movie')).not.toBeNull()
      expect(cursor.get('tv')).not.toBeNull()
    })
  })
})
