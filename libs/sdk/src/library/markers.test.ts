import { describe, it, expect } from 'vitest'
import { skippableAt, type Marker } from './markers.ts'

const markers: Marker[] = [
  { kind: 'recap', startMs: 4_000, endMs: 89_000 },
  { kind: 'intro', startMs: 93_000, endMs: 117_000 },
  { kind: 'credits', startMs: 2_815_000, endMs: 3_037_000 },
]

describe('skippableAt', () => {
  it('is the marker the position lies in', () => {
    expect(skippableAt(markers, 100_000)).toEqual(markers[1])
    expect(skippableAt(markers, 10_000)).toEqual(markers[0])
  })

  it('includes the start and excludes the end, so the button goes away as the marker ends', () => {
    expect(skippableAt(markers, 93_000)).toEqual(markers[1])
    expect(skippableAt(markers, 117_000)).toBeNull()
  })

  it('never offers the credits, there is nothing after them to skip to', () => {
    expect(skippableAt(markers, 2_900_000)).toBeNull()
  })

  it('is null between markers', () => {
    expect(skippableAt(markers, 90_000)).toBeNull()
  })

  it('is null without markers', () => {
    expect(skippableAt([], 10)).toBeNull()
  })
})
