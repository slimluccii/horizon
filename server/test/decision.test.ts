import { describe, it, expect } from 'vitest'
import { decidePlayback, type ClientCapabilities } from '../src/transcode/decision.ts'
import type { ProbeResult } from '../src/scanner/probe.ts'

const h265MkvProbe: Partial<ProbeResult> = {
  videoCodec: 'hevc',
  videoBitrate: 40_000_000,
  hdr: { dv: true, dvProfile: 7, hdr10: true, hdr10plus: false },
  container: 'matroska,webm',
  audioTracks: [{ index: 0, codec: 'truehd', channels: 8, language: 'eng', title: '', default: true }],
}

const shieldCaps: ClientCapabilities = {
  videoCodecs: ['hevc', 'h264'],
  audioCodecs: ['truehd', 'eac3', 'ac3', 'aac'],
  hdr: ['dv', 'hdr10'],
  maxBitrate: 0,
  container: ['matroska', 'mp4'],
}

const browserCaps: ClientCapabilities = {
  videoCodecs: ['h264'],
  audioCodecs: ['aac'],
  hdr: [],
  maxBitrate: 8000,
  container: ['mp4'],
}

const safariCaps: ClientCapabilities = {
  videoCodecs: ['hevc', 'h264'],
  audioCodecs: ['aac', 'ac3'],
  hdr: ['hdr10'],
  maxBitrate: 0,
  container: ['mp4'],
}

describe('decidePlayback', () => {
  it('returns direct-play for fully compatible client', () => {
    const result = decidePlayback(h265MkvProbe as ProbeResult, shieldCaps)
    expect(result.method).toBe('direct-play')
  })

  it('returns direct-stream when container unsupported but codecs ok', () => {
    const caps = { ...shieldCaps, container: ['mp4'] }
    const result = decidePlayback(h265MkvProbe as ProbeResult, caps)
    expect(result.method).toBe('direct-stream')
  })

  it('returns partial-transcode when video ok but audio not', () => {
    const caps = { ...safariCaps, container: ['mp4'] }
    const probe = { ...h265MkvProbe, hdr: { dv: false, hdr10: true, hdr10plus: false }, videoCodec: 'hevc' }
    const result = decidePlayback(probe as ProbeResult, caps)
    expect(result.method).toBe('partial-transcode')
  })

  it('returns transcode for browser (h264 only, SDR)', () => {
    const result = decidePlayback(h265MkvProbe as ProbeResult, browserCaps)
    expect(result.method).toBe('transcode')
  })

  it('forces transcode when maxBitrate exceeded even if codecs match', () => {
    const caps = { ...shieldCaps, maxBitrate: 8000 }
    const result = decidePlayback(h265MkvProbe as ProbeResult, caps)
    expect(result.method).toBe('transcode')
  })

  it('includes tonemap flag when HDR source + SDR client', () => {
    const result = decidePlayback(h265MkvProbe as ProbeResult, browserCaps)
    expect(result.needsToneMap).toBe(true)
  })
})
