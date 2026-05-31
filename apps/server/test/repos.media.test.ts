import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type DatabaseSync } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createMediaRepo, type MediaRepo, type MediaItem, type MediaItemRow, type MovieUpsert, type ShowUpsert, type EpisodeUpsert } from '../src/repos/media.ts'

function freshRepo(): { db: DatabaseSync; repo: MediaRepo } {
  const db = openDatabase(':memory:')
  migrate(db)
  return { db, repo: createMediaRepo(db) }
}

function movie(partial: Partial<MovieUpsert> = {}): MovieUpsert {
  return {
    id: 'mv-1',
    filePath: '/x/Oppenheimer.mkv',
    title: 'Oppenheimer',
    sortYear: 2023,
    durationSec: 10822,
    resolution: '3840x2160',
    videoCodec: 'hevc',
    container: 'matroska',
    hdr: { dv: true, hdr10: true, hdr10plus: false },
    audioTracks: [],
    subtitleTracks: [],
    mtimeMs: 1000,
    sizeBytes: 50_000_000,
    externalIds: { tmdb: 872585 },
    metadata: null,
    ...partial,
  }
}

function show(partial: Partial<ShowUpsert> = {}): ShowUpsert {
  return {
    id: 'sh-1',
    title: 'A Knight of the Seven Kingdoms',
    sortYear: 2026,
    externalIds: { tvdb: 433631 },
    metadata: null,
    ...partial,
  }
}

function episode(partial: Partial<EpisodeUpsert> = {}): EpisodeUpsert {
  return {
    id: 'ep-1',
    parentId: 'sh-1',
    filePath: '/shows/knight/s01e01.mkv',
    title: 'The Hedge Knight',
    season: 1,
    episode: 1,
    durationSec: 3600,
    resolution: '1920x1080',
    videoCodec: 'hevc',
    container: 'matroska',
    hdr: { dv: false, hdr10: false, hdr10plus: false },
    audioTracks: [],
    subtitleTracks: [],
    mtimeMs: 1000,
    sizeBytes: 10_000_000,
    externalIds: {},
    metadata: null,
    ...partial,
  }
}

describe('mediaRepo.upsertMovie', () => {
  it('inserts new movie with first/last seen set to now', () => {
    const { repo } = freshRepo()
    const m = repo.upsertMovie(movie())
    // Bookkeeping fields live on the row, not the domain projection.
    const row = repo.getInternal(m.id)!
    expect(row.firstSeenAt).toBe(row.lastSeenAt)
    expect(row.deletedAt).toBeNull()
  })

  it('updates last_seen on re-upsert without changing id', () => {
    const { repo } = freshRepo()
    const m1 = repo.upsertMovie(movie())
    const m2 = repo.upsertMovie(movie({ mtimeMs: 1000 }))
    expect(m2.id).toBe(m1.id)
    const r1 = repo.getInternal(m1.id)!
    const r2 = repo.getInternal(m2.id)!
    expect(r2.firstSeenAt).toBe(r1.firstSeenAt)
    expect(r2.lastSeenAt).toBeGreaterThanOrEqual(r1.lastSeenAt)
  })

  it('re-probes fields when mtime changed', () => {
    const { repo } = freshRepo()
    repo.upsertMovie(movie())
    const updated = repo.upsertMovie(movie({ mtimeMs: 2000, title: 'Oppenheimer (Directors Cut)' }))
    expect(updated.title).toBe('Oppenheimer (Directors Cut)')
  })

  it('revives a soft-deleted row', () => {
    const { db, repo } = freshRepo()
    repo.upsertMovie(movie())
    db.prepare('UPDATE media_items SET deleted_at = ? WHERE id = ?').run(999, 'mv-1')
    repo.upsertMovie(movie())
    expect(repo.getInternal('mv-1')!.deletedAt).toBeNull()
  })
})

describe('mediaRepo.softDeleteMissing', () => {
  it('marks rows missing from seenIds as deleted, leaves seen rows alone', () => {
    const { repo } = freshRepo()
    const a = repo.upsertMovie(movie({ id: 'a', filePath: '/a.mkv' }))
    repo.upsertMovie(movie({ id: 'b', filePath: '/b.mkv' }))
    repo.softDeleteMissing(new Set([a.id]))
    expect(repo.getInternal('a')!.deletedAt).toBeNull()
    expect(repo.getInternal('b')!.deletedAt).not.toBeNull()
    // Domain getById hides soft-deleted rows entirely.
    expect(repo.getById('b')).toBeNull()
  })

  it('does not overwrite deleted_at on already-deleted rows', () => {
    const { db, repo } = freshRepo()
    repo.upsertMovie(movie({ id: 'a', filePath: '/a.mkv' }))
    db.prepare('UPDATE media_items SET deleted_at = ? WHERE id = ?').run(500, 'a')
    repo.softDeleteMissing(new Set())
    expect(repo.getInternal('a')!.deletedAt).toBe(500)
  })
})

describe('mediaRepo.listMovies / listShows / getEpisodes', () => {
  it('listMovies excludes soft-deleted + non-movies', () => {
    const { repo } = freshRepo()
    repo.upsertMovie(movie({ id: 'a' }))
    repo.upsertShow(show({ id: 'sh' }))
    repo.softDeleteMissing(new Set(['a']))
    const list = repo.listMovies()
    expect(list.map(m => m.id)).toEqual(['a'])
  })

  it('listShows returns all live shows', () => {
    const { repo } = freshRepo()
    repo.upsertShow(show({ id: 's1' }))
    repo.upsertShow(show({ id: 's2', title: 'Other' }))
    expect(repo.listShows().length).toBe(2)
  })

  it('getEpisodes orders by season then episode', () => {
    const { repo } = freshRepo()
    repo.upsertShow(show())
    repo.upsertEpisode(episode({ id: 'e1', season: 1, episode: 2, filePath: '/shows/knight/s01e02.mkv' }))
    repo.upsertEpisode(episode({ id: 'e2', season: 1, episode: 1, filePath: '/shows/knight/s01e01.mkv' }))
    repo.upsertEpisode(episode({ id: 'e3', season: 2, episode: 1, filePath: '/shows/knight/s02e01.mkv' }))
    const eps = repo.getEpisodes('sh-1')
    expect(eps.map(e => e.id)).toEqual(['e2', 'e1', 'e3'])
  })
})

describe('mediaRepo.getById', () => {
  it('returns domain object with JSON fields parsed', () => {
    const { repo } = freshRepo()
    repo.upsertMovie(movie())
    const m = repo.getById('mv-1')
    expect(m!.hdr).toEqual({ dv: true, hdr10: true, hdr10plus: false })
  })
})

describe('Type Safety: MediaItem vs MediaItemRow', () => {
  // Compile-time assertions: no runtime effect, but the @ts-expect-error lines
  // must trigger a type error or the build fails. They prove that the two
  // shapes are NOT interchangeable — a route cannot mistake a server-internal
  // row for the wire-safe projection.
  //
  // Plain assignment (`const item: MediaItem = row`) is allowed by structural
  // subtyping (extra props are fine when widening a variable). To actually
  // catch the leak we assert *exact* shape equivalence: a MediaItemRow has
  // extra fields, so it is not the SAME shape as MediaItem.

  // True iff A and B are exactly the same type (mutually assignable, no excess).
  type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

  it('MediaItemRow is NOT shape-equivalent to MediaItem (carries server internals)', () => {
    // Equal<MediaItem, MediaItem> is true; Equal<MediaItemRow, MediaItem> is false.
    const sameAsItself: Exact<MediaItem, MediaItem> = true
    // @ts-expect-error MediaItemRow has extra server-internal fields (filePath,
    // bookkeeping) so it is NOT the same shape as the wire-safe MediaItem.
    const rowEqualsItem: Exact<MediaItemRow, MediaItem> = true
    expect(sameAsItself).toBe(true)
    expect(rowEqualsItem).toBe(true)
  })

  it('a constructed MediaItemRow exposes server-internal fields the wire shape lacks', () => {
    const row: MediaItemRow = {
      id: 'mv-1',
      kind: 'movie',
      parentId: null,
      title: 'Oppenheimer',
      year: 2023,
      season: null,
      episode: null,
      durationSec: 10822,
      resolution: '3840x2160',
      videoCodec: 'hevc',
      container: 'matroska',
      hdr: { dv: true, hdr10: true, hdr10plus: false },
      audioTracks: [],
      subtitleTracks: [],
      externalIds: { tmdb: 872585 },
      metadata: null,
      filePath: '/x/Oppenheimer.mkv',
      mtimeMs: 1000,
      sizeBytes: 50_000_000,
      firstSeenAt: 1,
      lastSeenAt: 1,
      deletedAt: null,
      tmdbId: 872585,
      metadataFetchedAt: null,
      metadataFailedAt: null,
      metadataFailedCount: 0,
    }
    expect(row.filePath).toBe('/x/Oppenheimer.mkv')
    // A MediaItem object literal cannot carry filePath (excess-property check).
    const item: MediaItem = {
      id: 'mv-1',
      kind: 'movie',
      parentId: null,
      title: 'Oppenheimer',
      year: 2023,
      season: null,
      episode: null,
      durationSec: 10822,
      resolution: '3840x2160',
      videoCodec: 'hevc',
      container: 'matroska',
      hdr: null,
      audioTracks: null,
      subtitleTracks: null,
      externalIds: {},
      metadata: null,
    }
    expect('filePath' in item).toBe(false)
  })
})
