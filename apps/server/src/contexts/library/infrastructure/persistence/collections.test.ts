import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase } from '../../../../db/index.ts'
import { migrate } from '../../../../db/migrations.ts'
import { createMediaRepo } from './media.ts'
import { createCollectionsRepo, type Collection } from './collections.ts'

function setup() {
  const db = openDatabase(':memory:')
  migrate(db)
  const media = createMediaRepo(db)
  const repo = createCollectionsRepo(db)
  // seed two movies so FK is valid
  media.upsertMovie({
    id: 'm1', filePath: '/a.mkv', title: 'Lord of the Rings I',
    sortYear: 2001, durationSec: 10000, resolution: '1920x1080',
    videoCodec: 'hevc', container: 'matroska',
    hdr: { dv: false, hdr10: false, hdr10plus: false },
    audioTracks: [], subtitleTracks: [], mtimeMs: 1, sizeBytes: 1,
    externalIds: {}, metadata: null,
  })
  media.upsertMovie({
    id: 'm2', filePath: '/b.mkv', title: 'Lord of the Rings II',
    sortYear: 2002, durationSec: 10000, resolution: '1920x1080',
    videoCodec: 'hevc', container: 'matroska',
    hdr: { dv: false, hdr10: false, hdr10plus: false },
    audioTracks: [], subtitleTracks: [], mtimeMs: 1, sizeBytes: 1,
    externalIds: {}, metadata: null,
  })
  return { db, repo }
}

describe('collectionsRepo.replaceAll', () => {
  it('stores collections with items in position order', () => {
    const { repo } = setup()
    repo.replaceAll([
      { id: 'c1', name: 'Lord of the Rings', tmdbId: null,
        posterPath: null, backdropPath: null, movieIds: ['m1', 'm2'] },
    ])
    const list = repo.list()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('Lord of the Rings')
    expect(list[0].movieIds).toEqual(['m1', 'm2'])
  })

  it('replaces existing collections wholesale', () => {
    const { repo } = setup()
    repo.replaceAll([{ id: 'c1', name: 'A', tmdbId: null, posterPath: null, backdropPath: null, movieIds: ['m1'] }])
    repo.replaceAll([{ id: 'c2', name: 'B', tmdbId: null, posterPath: null, backdropPath: null, movieIds: ['m2'] }])
    const list = repo.list()
    expect(list.map(c => c.id)).toEqual(['c2'])
  })

  it('round-trips tmdbId, posterPath, backdropPath', () => {
    const { repo } = setup()
    repo.replaceAll([
      { id: 'c1', name: 'Harry Potter Collection', tmdbId: 1241,
        posterPath: '/p.jpg', backdropPath: '/b.jpg', movieIds: ['m1', 'm2'] },
    ])
    const [c] = repo.list()
    expect(c).toMatchObject({
      id: 'c1', name: 'Harry Potter Collection', tmdbId: 1241,
      posterPath: '/p.jpg', backdropPath: '/b.jpg', movieIds: ['m1', 'm2'],
    })
  })
})
