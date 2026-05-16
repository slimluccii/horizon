import { describe, it, expect } from 'vitest'
import { parseIds, parseIdsFromPath, mergeIds } from '../src/scanner/ids.ts'

describe('parseIds', () => {
  it('returns empty when no tags', () => {
    expect(parseIds('Some Movie (2020)')).toEqual({})
  })

  it('extracts tmdb id', () => {
    expect(parseIds('Oppenheimer (2023) {tmdb-872585}')).toEqual({ tmdb: 872585 })
  })

  it('extracts tvdb id', () => {
    expect(parseIds('Show {tvdb-12345}')).toEqual({ tvdb: 12345 })
  })

  it('extracts imdb id', () => {
    expect(parseIds('Movie {imdb-tt1234567}')).toEqual({ imdb: 'tt1234567' })
  })

  it('handles all three together', () => {
    expect(parseIds('X {tmdb-1}{tvdb-2}{imdb-tt3}'))
      .toEqual({ tmdb: 1, tvdb: 2, imdb: 'tt3' })
  })

  it('is case insensitive on the prefix', () => {
    expect(parseIds('X {TMDB-42}')).toEqual({ tmdb: 42 })
  })
})

describe('mergeIds', () => {
  it('later wins', () => {
    expect(mergeIds({ tmdb: 1 }, { tmdb: 2 })).toEqual({ tmdb: 2 })
  })

  it('combines disjoint fields', () => {
    expect(mergeIds({ tmdb: 1 }, { tvdb: 2 }, { imdb: 'tt3' }))
      .toEqual({ tmdb: 1, tvdb: 2, imdb: 'tt3' })
  })
})

describe('parseIdsFromPath', () => {
  it('finds id in directory when filename has none', () => {
    const p = '/library/Movies/Oppenheimer (2023) {tmdb-872585}/Oppenheimer (2023).mkv'
    expect(parseIdsFromPath(p)).toEqual({ tmdb: 872585 })
  })

  it('filename id overrides directory id', () => {
    const p = '/library/Show {tvdb-1}/S01/E01 {tvdb-99}.mkv'
    expect(parseIdsFromPath(p)).toEqual({ tvdb: 99 })
  })

  it('combines IDs from different path segments', () => {
    const p = '/library/Show {tvdb-1}/Season 01/E01 {tmdb-7}.mkv'
    expect(parseIdsFromPath(p)).toEqual({ tvdb: 1, tmdb: 7 })
  })
})
