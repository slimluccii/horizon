import { describe, it, expect } from 'vitest'
import { SEGMENT_DURATION_SEC } from './ffmpeg.ts'

function startSegFor(positionMs: number): number {
  return Math.floor(positionMs / 1000 / SEGMENT_DURATION_SEC)
}

describe('startPositionMs → segment', () => {
  it('zero position → seg 0', () => {
    expect(startSegFor(0)).toBe(0)
  })
  it('1 s into SEGMENT_DURATION_SEC=1 → seg 1', () => {
    expect(startSegFor(1000)).toBe(1)
  })
  it('12s into 1s-seg config → seg 12', () => {
    expect(startSegFor(12_000)).toBe(12)
  })
})
