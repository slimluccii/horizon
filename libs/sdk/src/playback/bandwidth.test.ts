import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BandwidthSampler } from './bandwidth.ts'

describe('BandwidthSampler.record', () => {
  it('computes 10000 kbps for 125KB in 100ms', () => {
    // 125000 bytes * 8 = 1_000_000 bits over 0.1s = 10_000_000 bps = 10000 kbps
    const s = new BandwidthSampler()
    s.record(125_000, 100)
    expect(s.estimate()).toBe(10_000)
  })

  it('computes 1000 kbps for 125KB in 1000ms', () => {
    const s = new BandwidthSampler()
    s.record(125_000, 1000)
    expect(s.estimate()).toBe(1000)
  })

  it('skips zero/negative duration and zero/negative bytes', () => {
    const s = new BandwidthSampler()
    s.record(125_000, 0)
    s.record(125_000, -10)
    s.record(0, 100)
    s.record(-1, 100)
    expect(s.estimate()).toBe(0)
    expect(s.lastSample()).toBeUndefined()
  })
})

describe('BandwidthSampler.estimate', () => {
  it('returns 0 for an empty sampler', () => {
    expect(new BandwidthSampler().estimate()).toBe(0)
  })

  it('weights more recent samples higher', () => {
    const s = new BandwidthSampler()
    // two samples: 1000 kbps (weight 1), 2000 kbps (weight 2)
    s.record(125_000, 1000)   // 1000 kbps
    s.record(250_000, 1000)   // 2000 kbps
    // (1000*1 + 2000*2) / (1+2) = 5000/3 = 1667
    expect(s.estimate()).toBe(1667)
  })
})

describe('BandwidthSampler rolling window', () => {
  it('keeps only the last 5 samples', () => {
    const s = new BandwidthSampler()
    // 6 records of equal 1000 kbps; oldest shifted out, estimate stays 1000
    for (let i = 0; i < 6; i++) s.record(125_000, 1000)
    expect(s.estimate()).toBe(1000)
    // last sample is the most recent
    expect(s.lastSample()?.kbps).toBe(1000)
  })
})

describe('BandwidthSampler.lastSample', () => {
  it('returns a shallow copy that does not mutate internal state', () => {
    const s = new BandwidthSampler()
    s.record(125_000, 1000)
    const sample = s.lastSample()!
    sample.kbps = 999_999
    expect(s.lastSample()?.kbps).toBe(1000)
  })

  it('returns undefined when there are no samples', () => {
    expect(new BandwidthSampler().lastSample()).toBeUndefined()
  })
})

describe('BandwidthSampler.reset', () => {
  it('clears all samples', () => {
    const s = new BandwidthSampler()
    s.record(125_000, 1000)
    s.reset()
    expect(s.estimate()).toBe(0)
    expect(s.lastSample()).toBeUndefined()
  })
})
