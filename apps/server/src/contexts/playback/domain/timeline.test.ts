import { describe, it, expect } from 'vitest'
import { uniformTimeline, keyframeTimeline, copyEligible } from './timeline.ts'

describe('uniformTimeline', () => {
  const t = uniformTimeline(10.4)

  it('cuts the duration into one-second segments with a short last one', () => {
    expect(t.count).toBe(11)
    expect(t.startSec(0)).toBe(0)
    expect(t.startSec(7)).toBe(7)
    expect(t.durationSec(3)).toBe(1)
    expect(t.durationSec(10)).toBeCloseTo(0.4)
    expect(t.targetDurationSec).toBe(1)
  })

  it('finds the segment that holds a position', () => {
    expect(t.segmentAt(0)).toBe(0)
    expect(t.segmentAt(6.99)).toBe(6)
    expect(t.segmentAt(7)).toBe(7)
    expect(t.segmentAt(999)).toBe(10)
    expect(t.segmentAt(-5)).toBe(0)
  })

  it('always has at least one segment', () => {
    expect(uniformTimeline(0).count).toBe(1)
  })
})

describe('keyframeTimeline', () => {
  // The irregular file used to validate this against real ffmpeg: one segment per keyframe gap.
  const keyframes = [
    { ptsSec: 0, dtsSec: -0.083 }, { ptsSec: 0.5, dtsSec: 0.417 }, { ptsSec: 0.75, dtsSec: 0.667 },
    { ptsSec: 3.25, dtsSec: 3.167 }, { ptsSec: 3.5, dtsSec: 3.417 }, { ptsSec: 9, dtsSec: 8.917 },
    { ptsSec: 9.25, dtsSec: 9.167 }, { ptsSec: 15, dtsSec: 14.917 },
  ]
  const t = keyframeTimeline(keyframes, 23.856)

  it('has one segment per keyframe, as long as the gap to the next one', () => {
    expect(t.count).toBe(8)
    expect([0, 1, 2, 3, 4, 5, 6].map(n => t.durationSec(n))).toEqual([0.5, 0.25, 2.5, 0.25, 5.5, 0.25, 5.75])
    expect(t.durationSec(7)).toBeCloseTo(8.856)
    expect(t.startSec(5)).toBe(9)
  })

  it('declares the longest segment as the target duration, rounded up', () => {
    expect(t.targetDurationSec).toBe(9)
  })

  it('finds the segment that holds a position', () => {
    expect(t.segmentAt(0.6)).toBe(1)
    expect(t.segmentAt(8.99)).toBe(4)
    expect(t.segmentAt(9)).toBe(5)
    expect(t.segmentAt(500)).toBe(7)
  })

  it('gives the decode time of the keyframe a segment starts on, which is what ffmpeg trims against', () => {
    expect(t.startDtsSec(5)).toBe(8.917)
    expect(t.startDtsSec(0)).toBe(-0.083)
  })
})

describe('copyEligible', () => {
  const every = (gap: number, count: number) => Array.from({ length: count }, (_, i) => ({ ptsSec: i * gap, dtsSec: i * gap }))

  it('accepts ordinary keyframe spacing', () => {
    expect(copyEligible(every(2, 100), 200)).toBe(true)
  })

  it('rejects all-intra style files, which would become one segment per frame', () => {
    expect(copyEligible(every(0.04, 1000), 40)).toBe(false)
  })

  it('rejects files with a gap too long to seek or buffer sensibly', () => {
    const kf = [...every(2, 10), { ptsSec: 60, dtsSec: 60 }]
    expect(copyEligible(kf, 62)).toBe(false)
  })

  it('rejects an empty index and one that does not start at the beginning', () => {
    expect(copyEligible([], 100)).toBe(false)
    expect(copyEligible([{ ptsSec: 12, dtsSec: 12 }, { ptsSec: 14, dtsSec: 14 }], 100)).toBe(false)
  })
})
