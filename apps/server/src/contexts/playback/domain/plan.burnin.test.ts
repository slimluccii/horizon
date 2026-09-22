import { describe, it, expect } from 'vitest'
import { buildPlan, planWithBurnIn, type PlanInput } from './plan.ts'
import type { ProbeResult } from '../../library/index.ts'

function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    duration: 7200,
    resolution: '1920x1080',
    videoCodec: 'h264',
    videoBitrate: 8_000_000,
    hdr: { dv: false, hdr10: false, hdr10plus: false },
    audioTracks: [{ index: 0, codec: 'aac', channels: 2, language: 'eng', title: '', default: true }],
    subtitleTracks: [],
    container: 'matroska,webm',
    ...overrides,
  }
}

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    probe: probe(),
    // Capabilities that would allow direct-play of the probe above.
    capabilities: { videoCodecs: ['h264'], audioCodecs: ['aac'], hdr: [], maxBitrate: 0, container: ['mkv'] },
    hwAccel: { ffmpegVersion: 'x', encoder: 'cpu', h264Encoder: 'libx264', hevcEncoder: 'libx265', hwaccelDecode: [], h264SupportsA53cc: true },
    audioTrackIndex: 0,
    maxRenditions: 3,
    toneMap: { operator: 'hable', postCorrection: true },
    ...overrides,
  }
}

describe('buildPlan with burn-in subtitle', () => {
  it('forces transcode even when the client could direct-play (happy path)', () => {
    const withoutBurnIn = buildPlan(input())
    expect(withoutBurnIn.method).toBe('direct-play')

    const plan = buildPlan(input({ burnInSubtitleIndex: 0 }))
    expect(plan.method).toBe('transcode')
    expect(plan.burnInSubtitleIndex).toBe(0)
    expect(plan.renditions.length).toBeGreaterThan(0)
  })

  it('tone-maps an HDR source on the burn-in path even for an HDR-capable client', () => {
    const hdrProbe = probe({ videoCodec: 'hevc', hdr: { dv: false, hdr10: true, hdr10plus: false } })
    const caps = { videoCodecs: ['hevc', 'h264'], audioCodecs: ['aac'], hdr: ['hdr10'], maxBitrate: 0, container: ['mkv'] }
    const plan = buildPlan(input({ probe: hdrProbe, capabilities: caps, burnInSubtitleIndex: 1 }))
    expect(plan.method).toBe('transcode')
    // Output ladder is SDR H.264, so HDR must be tone-mapped despite client support.
    expect(plan.needsToneMap).toBe(true)
  })

  it('defaults to no burn-in', () => {
    const plan = buildPlan(input({ capabilities: { videoCodecs: [], audioCodecs: [], hdr: [], maxBitrate: 0, container: [] } }))
    expect(plan.method).toBe('transcode')
    expect(plan.burnInSubtitleIndex).toBeNull()
  })
})

describe('planWithBurnIn', () => {
  it('swaps only the burn-in index', () => {
    const prev = buildPlan(input({ capabilities: { videoCodecs: [], audioCodecs: [], hdr: [], maxBitrate: 0, container: [] } }))
    const next = planWithBurnIn(prev, 2)
    expect(next.burnInSubtitleIndex).toBe(2)
    expect(next.renditions).toEqual(prev.renditions)
    expect(planWithBurnIn(next, null).burnInSubtitleIndex).toBeNull()
  })
})
