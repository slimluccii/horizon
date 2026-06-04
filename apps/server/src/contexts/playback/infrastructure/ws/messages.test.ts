import { describe, it, expect } from 'vitest'
import { parseWsMessage } from './messages.ts'

describe('parseWsMessage', () => {
  it('returns null for non-objects', () => {
    expect(parseWsMessage(null)).toBeNull()
    expect(parseWsMessage('hello')).toBeNull()
    expect(parseWsMessage(42)).toBeNull()
    expect(parseWsMessage(undefined)).toBeNull()
  })

  it('returns null for unknown discriminator', () => {
    expect(parseWsMessage({ type: 'nope' })).toBeNull()
    expect(parseWsMessage({})).toBeNull()
  })

  it('parses hello with token', () => {
    expect(parseWsMessage({ type: 'hello', reconnectToken: 'abc' }))
      .toEqual({ type: 'hello', reconnectToken: 'abc' })
  })

  it('parses hello without token', () => {
    expect(parseWsMessage({ type: 'hello' }))
      .toEqual({ type: 'hello', reconnectToken: undefined })
  })

  it('rejects bandwidth-report missing required fields', () => {
    expect(parseWsMessage({ type: 'bandwidth-report' })).toBeNull()
    expect(parseWsMessage({ type: 'bandwidth-report', kbps: 5000 })).toBeNull()
  })

  it('parses bandwidth-report', () => {
    const m = parseWsMessage({ type: 'bandwidth-report', kbps: 5000, bufferSeconds: 12 })
    expect(m).toEqual({ type: 'bandwidth-report', kbps: 5000, bufferSeconds: 12, segmentDownloadMs: undefined })
  })

  it('rejects negative seek positions', () => {
    expect(parseWsMessage({ type: 'seek', positionMs: -1 })).toBeNull()
  })

  it('parses seek', () => {
    expect(parseWsMessage({ type: 'seek', positionMs: 12_000 }))
      .toEqual({ type: 'seek', positionMs: 12_000 })
  })

  it('parses subtitle-track null (off)', () => {
    expect(parseWsMessage({ type: 'subtitle-track', index: null }))
      .toEqual({ type: 'subtitle-track', index: null })
  })

  it('rejects subtitle-track with invalid index', () => {
    expect(parseWsMessage({ type: 'subtitle-track', index: 'foo' })).toBeNull()
    expect(parseWsMessage({ type: 'subtitle-track', index: -1 })).toBeNull()
  })

  it('parses park / resume', () => {
    expect(parseWsMessage({ type: 'park' })).toEqual({ type: 'park' })
    expect(parseWsMessage({ type: 'resume' })).toEqual({ type: 'resume' })
  })

  it('parses quality-override with positionMs', () => {
    expect(parseWsMessage({ type: 'quality-override', bitrate: 4000, positionMs: 12_345 }))
      .toEqual({ type: 'quality-override', bitrate: 4000, positionMs: 12_345 })
  })

  it('drops invalid positionMs on quality-override', () => {
    expect(parseWsMessage({ type: 'quality-override', bitrate: 4000, positionMs: -5 }))
      .toEqual({ type: 'quality-override', bitrate: 4000, positionMs: undefined })
    expect(parseWsMessage({ type: 'quality-override', bitrate: 4000, positionMs: 'bad' }))
      .toEqual({ type: 'quality-override', bitrate: 4000, positionMs: undefined })
  })

  it('parses audio-track with positionMs', () => {
    expect(parseWsMessage({ type: 'audio-track', index: 1, positionMs: 60_000 }))
      .toEqual({ type: 'audio-track', index: 1, positionMs: 60_000 })
  })

  it('parses progress', () => {
    expect(parseWsMessage({ type: 'progress', positionMs: 1500, durationMs: 60_000 }))
      .toEqual({ type: 'progress', positionMs: 1500, durationMs: 60_000 })
  })

  it('rejects progress with negative position', () => {
    expect(parseWsMessage({ type: 'progress', positionMs: -5, durationMs: 60_000 })).toBeNull()
  })
})
