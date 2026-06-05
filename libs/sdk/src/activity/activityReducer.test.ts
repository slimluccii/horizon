import { describe, it, expect } from 'vitest'
import { activityReducer, initialActivityState } from './activityReducer.ts'
import type { ActivityEvent } from './activity.ts'

const ev = (e: Partial<ActivityEvent>): ActivityEvent => ({ seq: 0, ts: 0, message: 'm', ...(e as any) })

describe('activityReducer', () => {
  it('tracks scan phase + counts from detected, finalizes on done', () => {
    let s = initialActivityState
    s = activityReducer(s, ev({ kind: 'scan:start', trigger: 'manual', scope: 'full' }))
    expect(s.phase).toBe('scanning')
    s = activityReducer(s, ev({ kind: 'scan:detected', mediaKind: 'movie', title: 'A' }))
    s = activityReducer(s, ev({ kind: 'scan:detected', mediaKind: 'show', title: 'B' }))
    expect(s.counts).toEqual({ movies: 1, shows: 1, episodes: 0 })
    s = activityReducer(s, ev({ kind: 'scan:done', movies: 10, shows: 3, added: 1, removed: 0, failed: 0, durationMs: 5 }))
    expect(s.counts).toMatchObject({ movies: 10, shows: 3 })
    expect(s.progress).toBeNull()
  })

  it('tracks current metadata step and resets on meta:done', () => {
    let s = activityReducer(initialActivityState, ev({ kind: 'meta:start' }))
    expect(s.phase).toBe('metadata')
    s = activityReducer(s, ev({ kind: 'meta:item', step: 'fetching', mediaKind: 'movie', title: 'A', tmdbId: 7 }))
    expect(s.current).toMatchObject({ step: 'fetching', title: 'A', tmdbId: 7 })
    s = activityReducer(s, ev({ kind: 'meta:done', refreshed: 1, failed: 0, durationMs: 1 }))
    expect(s.phase).toBe('idle')
    expect(s.current).toBeNull()
  })

  it('caps rawLines at 500', () => {
    let s = initialActivityState
    for (let i = 0; i < 600; i++) s = activityReducer(s, ev({ kind: 'error', code: 'x', message: `e${i}` }))
    expect(s.rawLines.length).toBe(500)
    expect(s.rawLines[s.rawLines.length - 1]).toContain('e599')
  })
})
