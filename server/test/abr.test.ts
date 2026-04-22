import { describe, it, expect } from 'vitest'
import { computeAbrAction, type AbrState } from '../src/ws/handler.ts'
import { PROFILES } from '../src/transcode/profiles.ts'

describe('computeAbrAction', () => {
  const state: AbrState = {
    currentProfileIndex: 1, // 1080p-hi
    lastChangeAt: 0,
    cooldownMs: 15_000,
    profiles: PROFILES.slice(0, 4), // 4K, 1080p-hi, 1080p, 720p
  }

  it('steps down 2 on critical buffer', () => {
    const action = computeAbrAction({ kbps: 30000, bufferSeconds: 2 }, state, Date.now())
    expect(action).toBe('emergency-down')
  })

  it('steps down 1 on low buffer', () => {
    const action = computeAbrAction({ kbps: 30000, bufferSeconds: 6 }, state, Date.now())
    expect(action).toBe('down')
  })

  it('steps down when bandwidth insufficient', () => {
    // current profile 1080p-hi = 20000 kbps, reported 15000 < 20000*1.2=24000
    const action = computeAbrAction({ kbps: 15000, bufferSeconds: 20 }, state, Date.now())
    expect(action).toBe('down')
  })

  it('steps up when bandwidth high and buffer healthy', () => {
    const stateAt1080p = { ...state, currentProfileIndex: 2 } // 1080p
    // next profile up = 1080p-hi = 20000 kbps, reported 35000 > 20000*1.5=30000, buffer 18
    const action = computeAbrAction({ kbps: 35000, bufferSeconds: 18 }, stateAt1080p, Date.now())
    expect(action).toBe('up')
  })

  it('respects cooldown on step-up', () => {
    const stateAt1080p = { ...state, currentProfileIndex: 2, lastChangeAt: Date.now() - 5000 }
    const action = computeAbrAction({ kbps: 35000, bufferSeconds: 18 }, stateAt1080p, Date.now())
    expect(action).toBe('none')
  })

  it('ignores cooldown on emergency down', () => {
    const stateRecent = { ...state, lastChangeAt: Date.now() - 1000 }
    const action = computeAbrAction({ kbps: 30000, bufferSeconds: 2 }, stateRecent, Date.now())
    expect(action).toBe('emergency-down')
  })
})
