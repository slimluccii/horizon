import { describe, it, expect } from 'vitest'
import { nextDailyFireAt } from '../src/scheduler.ts'

describe('nextDailyFireAt', () => {
  it('returns today at the target hour when from is earlier', () => {
    const from = new Date('2026-05-15T01:30:00')
    const next = new Date(nextDailyFireAt(from, 3, 0))
    expect(next.getHours()).toBe(3)
    expect(next.getMinutes()).toBe(0)
    expect(next.getDate()).toBe(15)
  })

  it('returns tomorrow when from is past the target hour', () => {
    const from = new Date('2026-05-15T05:30:00')
    const next = new Date(nextDailyFireAt(from, 3, 0))
    expect(next.getHours()).toBe(3)
    expect(next.getDate()).toBe(16)
  })

  it('rolls forward across month boundary', () => {
    const from = new Date('2026-04-30T22:00:00')
    const next = new Date(nextDailyFireAt(from, 3, 0))
    expect(next.getMonth()).toBe(4)               // May (0-indexed)
    expect(next.getDate()).toBe(1)
    expect(next.getHours()).toBe(3)
  })

  it('strict-after when from equals the target time', () => {
    const from = new Date('2026-05-15T03:00:00')
    const next = new Date(nextDailyFireAt(from, 3, 0))
    expect(next.getDate()).toBe(16)
  })
})
