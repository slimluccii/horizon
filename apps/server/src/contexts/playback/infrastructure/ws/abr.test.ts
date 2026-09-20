import { describe, it, expect } from 'vitest'
import { computeAbrAction, computeDemote, type AbrState } from './handler.ts'
import { PROFILES } from '../../domain/profiles.ts'

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

  it('respects cooldown on emergency down too (prevents restart thrash)', () => {
    // Previously emergency-down bypassed cooldown, which caused ffmpeg thrashing
    // on cold starts: freshly-spawned run sees buffer=0 → emergency-down →
    // kill+respawn → racing the still-warming first run.
    const stateRecent = { ...state, lastChangeAt: Date.now() - 1000 }
    const action = computeAbrAction({ kbps: 30000, bufferSeconds: 2 }, stateRecent, Date.now())
    expect(action).toBe('none')
  })
})

describe('computeDemote (copy-video → transcode)', () => {
  const src = 40_000 // 40 Mbps remux

  it('demotes after sustained under-bandwidth reports with a draining buffer', () => {
    let state = { lowCount: 0, demoted: false }
    let out = computeDemote({ kbps: 20_000, bufferSeconds: 10 }, src, state)
    expect(out.demote).toBe(false)
    out = computeDemote({ kbps: 18_000, bufferSeconds: 8 }, src, out.state)
    expect(out.demote).toBe(false)
    out = computeDemote({ kbps: 19_000, bufferSeconds: 6 }, src, out.state)
    expect(out.demote).toBe(true)
    expect(out.state.demoted).toBe(true)
  })

  it('a healthy report resets the streak (transient dip tolerated)', () => {
    let out = computeDemote({ kbps: 20_000, bufferSeconds: 10 }, src, { lowCount: 0, demoted: false })
    out = computeDemote({ kbps: 20_000, bufferSeconds: 10 }, src, out.state)
    // Bandwidth recovers above source — streak resets.
    out = computeDemote({ kbps: 60_000, bufferSeconds: 20 }, src, out.state)
    expect(out.state.lowCount).toBe(0)
    out = computeDemote({ kbps: 20_000, bufferSeconds: 10 }, src, out.state)
    expect(out.demote).toBe(false)
  })

  it('never fires twice, with unknown source bitrate, or with a healthy buffer', () => {
    expect(computeDemote({ kbps: 1000, bufferSeconds: 1 }, src, { lowCount: 0, demoted: true }).demote).toBe(false)
    expect(computeDemote({ kbps: 1000, bufferSeconds: 1 }, 0, { lowCount: 99, demoted: false }).demote).toBe(false)
    // Slow link but big buffer: the client is just pacing fetches.
    let out = computeDemote({ kbps: 20_000, bufferSeconds: 30 }, src, { lowCount: 0, demoted: false })
    expect(out.state.lowCount).toBe(0)
  })
})
