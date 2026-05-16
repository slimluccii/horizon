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
      async movieByTmdbId(id) {
        movieCalls++
        return { kind: 'movie', tmdbId: id, title: `Movie ${id}` } as any
      },
      async movieByImdbId() { return null },
      async searchMovie() { return null },
      async showByTmdbId() { return null },
      async showByTvdbId() { return null },
      async searchShow() { return null },
      async episode() { return null },
      async changedMovieIds(start, end) {
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
})
