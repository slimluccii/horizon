import { describe, it, expect } from 'vitest'
import { detectCollections, stripCollectionSuffix } from '../src/scanner/collections.ts'

describe('stripCollectionSuffix', () => {
  it('strips Part N', () => expect(stripCollectionSuffix('The Godfather Part II')).toBe('The Godfather'))
  it('strips Chapter N', () => expect(stripCollectionSuffix('John Wick Chapter 2')).toBe('John Wick'))
  it('strips Vol. N', () => expect(stripCollectionSuffix('Kill Bill Vol. 1')).toBe('Kill Bill'))
  it('strips trailing Roman numerals II-XX', () => expect(stripCollectionSuffix('Rocky III')).toBe('Rocky'))
  it('does NOT strip bare digits (Blade Runner 2049)', () => expect(stripCollectionSuffix('Blade Runner 2049')).toBe('Blade Runner 2049'))
  it('strips year before suffix check', () => expect(stripCollectionSuffix('John Wick (2014)')).toBe('John Wick'))
  it('handles no suffix', () => expect(stripCollectionSuffix('Inception')).toBe('Inception'))
})

describe('detectCollections', () => {
  it('groups movies with same base into collection', () => {
    const movies = [
      { id: '1', title: 'John Wick', year: 2014 },
      { id: '2', title: 'John Wick Chapter 2', year: 2017 },
      { id: '3', title: 'John Wick Chapter 3 - Parabellum', year: 2019 },
    ] as any[]
    const cols = detectCollections(movies)
    expect(cols).toHaveLength(1)
    expect(cols[0].name).toBe('John Wick')
    expect(cols[0].movies).toHaveLength(3)
    expect(cols[0].movies[0].year).toBe(2014)
  })

  it('does not create collection for single movie', () => {
    const movies = [{ id: '1', title: 'Inception', year: 2010 }] as any[]
    expect(detectCollections(movies)).toHaveLength(0)
  })

  it('does not merge Blade Runner 2049 with Blade Runner', () => {
    const movies = [
      { id: '1', title: 'Blade Runner', year: 1982 },
      { id: '2', title: 'Blade Runner 2049', year: 2017 },
    ] as any[]
    const cols = detectCollections(movies)
    expect(cols).toHaveLength(0)
  })

  it('sorts by year ascending', () => {
    const movies = [
      { id: '2', title: 'Rocky II', year: 1979 },
      { id: '1', title: 'Rocky', year: 1976 },
      { id: '3', title: 'Rocky III', year: 1982 },
    ] as any[]
    const cols = detectCollections(movies)
    expect(cols[0].movies.map((m: any) => m.year)).toEqual([1976, 1979, 1982])
  })
})
