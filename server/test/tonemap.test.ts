import { describe, it, expect } from 'vitest'
import { buildToneMapPrefix, isToneMapOperator, ALL_TONEMAP_OPERATORS } from '../src/transcode/tonemap.ts'

describe('isToneMapOperator', () => {
  it('accepts every documented operator', () => {
    for (const op of ALL_TONEMAP_OPERATORS) {
      expect(isToneMapOperator(op)).toBe(true)
    }
  })

  it('rejects unknown operators', () => {
    expect(isToneMapOperator('aces')).toBe(false)
    expect(isToneMapOperator('')).toBe(false)
    expect(isToneMapOperator('HABLE')).toBe(false)
  })
})

describe('buildToneMapPrefix', () => {
  it('emits hable chain with default post-correction', () => {
    const s = buildToneMapPrefix({ operator: 'hable' })
    expect(s).toContain('tonemap=hable')
    expect(s).toContain('format=yuv420p')
    expect(s).toContain('eq=gamma=1.15')   // hable post-correction
    expect(s.endsWith(',')).toBe(true)     // ready for chain concat
  })

  it('emits mobius chain with param + post-correction', () => {
    const s = buildToneMapPrefix({ operator: 'mobius' })
    expect(s).toContain('tonemap=mobius')
    expect(s).toContain('param=0.3')
    expect(s).toContain('eq=gamma=1.25')
  })

  it('honours param override', () => {
    const s = buildToneMapPrefix({ operator: 'hable', param: 0.5 })
    expect(s).toContain('param=0.5')
  })

  it('honours desat override (including 0)', () => {
    const s = buildToneMapPrefix({ operator: 'hable', desat: 0 })
    expect(s).toContain('desat=0')
  })

  it('skips post-correction when disabled', () => {
    const s = buildToneMapPrefix({ operator: 'hable', postCorrection: false })
    expect(s).not.toContain('eq=')
    expect(s).toContain('tonemap=hable')
  })

  it('clip and linear get no post-correction', () => {
    expect(buildToneMapPrefix({ operator: 'clip' })).not.toContain('eq=')
    expect(buildToneMapPrefix({ operator: 'linear' })).not.toContain('eq=')
  })

  it('reinhard gets contrast-boosted correction', () => {
    const s = buildToneMapPrefix({ operator: 'reinhard' })
    expect(s).toContain('contrast=1.15')
  })
})
