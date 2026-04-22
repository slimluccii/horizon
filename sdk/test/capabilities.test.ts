import { describe, it, expect, vi } from 'vitest'
import { detectCapabilities } from '../src/capabilities.ts'

describe('detectCapabilities', () => {
  it('returns safe defaults when MediaSource unavailable (non-browser)', () => {
    const caps = detectCapabilities()
    expect(caps.videoCodecs).toContain('h264')
    expect(caps.audioCodecs).toContain('aac')
    expect(caps.container).toContain('mp4')
    expect(caps.maxBitrate).toBe(0)
  })
})
