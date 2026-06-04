import { describe, it, expect } from 'vitest'
import { mergeMoviesAndCollections } from './collections.ts'
import type { MediaItem } from './mediaItem.ts'
import type { CollectionSummary } from './collections.ts'

const mv = (id: string, title: string): MediaItem => ({ id, kind: 'movie', title } as unknown as MediaItem)
const col = (id: string, name: string, movies: MediaItem[]): CollectionSummary =>
  ({ id, name, tmdbId: null, posterPath: null, backdropPath: null, movies })

describe('mergeMoviesAndCollections', () => {
  const m1 = mv('1', 'HP1'), m2 = mv('2', 'HP2'), m3 = mv('3', 'Inception')
  const c1 = col('c1', 'Harry Potter Collection', [m1, m2])

  it('collapse off → every movie as a movie entry', () => {
    const entries = mergeMoviesAndCollections([m1, m2, m3], [c1], false)
    expect(entries).toHaveLength(3)
    expect(entries.every(e => e.kind === 'movie')).toBe(true)
  })

  it('collapse on → collection entry replaces its members; standalone movie kept once', () => {
    const entries = mergeMoviesAndCollections([m1, m2, m3], [c1], true)
    const kinds = entries.map(e => e.kind).sort()
    expect(kinds).toEqual(['collection', 'movie'])
    const colEntry = entries.find(e => e.kind === 'collection')
    expect(colEntry && colEntry.kind === 'collection' && colEntry.collection.id).toBe('c1')
    const movieEntry = entries.find(e => e.kind === 'movie')
    expect(movieEntry && movieEntry.kind === 'movie' && movieEntry.movie.id).toBe('3')
  })
})
