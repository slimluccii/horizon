import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type DatabaseSync } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import {
  createScanRootsRepo,
  createChangesCursorRepo,
  createScanHistoryRepo,
} from '../src/repos/scanState.ts'

let db: DatabaseSync

beforeEach(() => {
  db = openDatabase(':memory:')
  migrate(db)
})

describe('scanRootsRepo', () => {
  it('upserts and reads root bookkeeping', () => {
    const repo = createScanRootsRepo(db)
    repo.set({ rootPath: '/movies', lastScannedAt: 100, lastDurationMs: 500, lastSeenCount: 12 })
    expect(repo.get('/movies')).toEqual({
      rootPath: '/movies', lastScannedAt: 100, lastDurationMs: 500, lastSeenCount: 12,
    })
    repo.set({ rootPath: '/movies', lastScannedAt: 200, lastDurationMs: 600, lastSeenCount: 13 })
    expect(repo.get('/movies')?.lastScannedAt).toBe(200)
    expect(repo.list().length).toBe(1)
  })
})

describe('changesCursorRepo', () => {
  it('upserts cursors per kind', () => {
    const repo = createChangesCursorRepo(db)
    expect(repo.get('movie')).toBeNull()
    repo.set({ kind: 'movie', lastWindowEnd: 1234, lastFetchedAt: 5678 })
    expect(repo.get('movie')).toEqual({ kind: 'movie', lastWindowEnd: 1234, lastFetchedAt: 5678 })
    repo.set({ kind: 'tv', lastWindowEnd: 999, lastFetchedAt: 1111 })
    expect(repo.get('tv')?.lastWindowEnd).toBe(999)
    expect(repo.get('movie')?.lastWindowEnd).toBe(1234)        // independent
  })
})

describe('scanHistoryRepo', () => {
  it('begins, finishes, and returns most recent first', () => {
    const repo = createScanHistoryRepo(db)
    const id1 = repo.begin('boot', 'full', 100)
    const id2 = repo.begin('manual', 'full', 200)
    repo.finish(id1, {
      finishedAt: 150, itemsSeen: 5, itemsAdded: 2, itemsRemoved: 1,
      metadataRefreshed: 0, errors: [],
    })
    repo.finish(id2, {
      finishedAt: 250, itemsSeen: 7, itemsAdded: 0, itemsRemoved: 0,
      metadataRefreshed: 3, errors: ['oops'],
    })
    const recent = repo.recent(5)
    expect(recent.length).toBe(2)
    expect(recent[0].id).toBe(id2)
    expect(recent[0].errors).toEqual(['oops'])
    expect(recent[1].itemsAdded).toBe(2)
  })

  it('prune keeps only the latest N rows', () => {
    const repo = createScanHistoryRepo(db)
    for (let i = 0; i < 10; i++) {
      const id = repo.begin('cron', 'full', 100 + i)
      repo.finish(id, {
        finishedAt: 200 + i, itemsSeen: 0, itemsAdded: 0, itemsRemoved: 0,
        metadataRefreshed: 0, errors: [],
      })
    }
    const removed = repo.prune(3)
    expect(removed).toBe(7)
    expect(repo.recent(10).length).toBe(3)
  })
})
