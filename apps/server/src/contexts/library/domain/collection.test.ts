import { describe, it, expect } from 'vitest'
import { buildCollections } from './collection.ts'
import type { MediaItem } from '../infrastructure/persistence/media.ts'

function movie(id: string, title: string, year: number, col?: { tmdbId: number; name: string; posterPath?: string; backdropPath?: string }): MediaItem {
  return {
    id, kind: 'movie', parentId: null, title, year, season: null, episode: null,
    durationSec: null, resolution: null, videoCodec: null, container: null, hdr: null,
    audioTracks: null, subtitleTracks: null, externalIds: {},
    metadata: col ? { kind: 'movie', title, collection: col } : { kind: 'movie', title },
  } as unknown as MediaItem
}

describe('buildCollections', () => {
  it('groups movies sharing a TMDB collection, sorted by year', () => {
    const hp = { tmdbId: 1241, name: 'Harry Potter Collection', posterPath: '/p.jpg', backdropPath: '/b.jpg' }
    const movies = [
      movie('b', 'Chamber of Secrets', 2002, hp),
      movie('a', "Philosopher's Stone", 2001, hp),
      movie('x', 'Inception', 2010),
    ]
    const cols = buildCollections(movies)
    expect(cols).toHaveLength(1)
    expect(cols[0]).toMatchObject({ name: 'Harry Potter Collection', tmdbId: 1241, posterPath: '/p.jpg', backdropPath: '/b.jpg' })
    expect(cols[0].movieIds).toEqual(['a', 'b']) // year-sorted
  })

  it('skips collections with fewer than 2 owned films', () => {
    const solo = { tmdbId: 99, name: 'Solo Collection' }
    expect(buildCollections([movie('a', 'Only One', 2000, solo)])).toHaveLength(0)
  })

  it('ignores movies without collection metadata', () => {
    expect(buildCollections([movie('a', 'A', 2000), movie('b', 'B', 2001)])).toHaveLength(0)
  })
})
