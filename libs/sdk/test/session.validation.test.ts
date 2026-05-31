import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PlaybackSession, type PlaybackSessionOptions } from '../src/session.ts'
import { parseServerMessage } from '../src/ws-messages.ts'
import type { SessionInfo } from '../src/types.ts'

// Minimal fake WebSocket the session constructor instantiates. Captures the
// handler assignments so tests can drive onopen/onmessage directly.
class FakeWebSocket {
  static OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = FakeWebSocket.OPEN
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }
  send(data: string) { this.sent.push(data) }
  close() {}
}

const baseSessionInfo: SessionInfo = {
  sessionId: 's1',
  method: 'transcode',
  streamUrl: '/sessions/s1/stream.m3u8',
  wsUrl: '/sessions/s1/ws',
  profiles: [{ videoBitrate: 8000, audioBitrate: 192, width: 1920, height: 1080 }],
  selectedAudioTrack: 0,
  selectedSubtitleTrack: null,
}

function makeSession(overrides: Partial<PlaybackSessionOptions> = {}) {
  const onReady = vi.fn()
  const onQualityChange = vi.fn()
  const onTrackChange = vi.fn()
  const onWarning = vi.fn()
  const onError = vi.fn()
  const session = new PlaybackSession({
    sessionInfo: baseSessionInfo,
    baseUrl: 'http://x',
    capabilities: { videoCodecs: [], audioCodecs: [], hdr: [], maxBitrate: 0, container: [] },
    onReady, onQualityChange, onTrackChange, onWarning, onError,
    ...overrides,
  })
  return { session, onReady, onQualityChange, onTrackChange, onWarning, onError }
}

async function flushMicrotasks() {
  // session._connect() runs in a queued microtask
  await Promise.resolve()
  await Promise.resolve()
}

function deliver(msg: unknown) {
  const ws = FakeWebSocket.instances.at(-1)!
  ws.onmessage?.({ data: JSON.stringify(msg) })
}

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true }) as unknown as Response))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseServerMessage', () => {
  it('accepts a valid session-ready frame', () => {
    const out = parseServerMessage({ type: 'session-ready', profile: { videoBitrate: 8000, audioBitrate: 192 }, reconnectToken: 't' })
    expect(out?.type).toBe('session-ready')
  })

  it('rejects a profile with a string videoBitrate', () => {
    expect(parseServerMessage({ type: 'session-ready', profile: { videoBitrate: 'fast', audioBitrate: 192 } })).toBeNull()
  })

  it('rejects quality-changed when reason is an array', () => {
    expect(parseServerMessage({ type: 'quality-changed', profile: { videoBitrate: 1, audioBitrate: 1 }, reason: ['x'] })).toBeNull()
  })

  it('rejects unknown fields via .strict()', () => {
    expect(parseServerMessage({ type: 'quality-changed', profile: { videoBitrate: 1, audioBitrate: 1 }, reason: 'r', evil: 1 })).toBeNull()
  })

  it('rejects null and non-object input', () => {
    expect(parseServerMessage(null)).toBeNull()
    expect(parseServerMessage('session-ready')).toBeNull()
    expect(parseServerMessage(42)).toBeNull()
  })

  it('rejects an unknown message type', () => {
    expect(parseServerMessage({ type: 'definitely-not-a-real-type' })).toBeNull()
  })
})

describe('PlaybackSession message validation', () => {
  it('applies a valid session-ready message (state + profile updated, onReady fired)', async () => {
    const { session, onReady } = makeSession()
    await flushMicrotasks()
    FakeWebSocket.instances.at(-1)!.onopen?.()
    deliver({ type: 'session-ready', profile: { videoBitrate: 4000, audioBitrate: 128 }, reconnectToken: 'tok' })
    expect(session.state).toBe('active')
    expect(session.profile.videoBitrate).toBe(4000)
    expect(onReady).toHaveBeenCalledOnce()
  })

  it('drops a malformed profile (videoBitrate string) without mutating state or firing onReady', async () => {
    const { session, onReady } = makeSession()
    await flushMicrotasks()
    const before = session.profile
    deliver({ type: 'session-ready', profile: { videoBitrate: 'fast', audioBitrate: 128 } })
    expect(session.state).toBe('attaching')
    expect(session.profile).toBe(before)
    expect(onReady).not.toHaveBeenCalled()
  })

  it('drops a frame with an unknown injected field (.strict)', async () => {
    const { session, onQualityChange } = makeSession()
    await flushMicrotasks()
    deliver({ type: 'quality-changed', profile: { videoBitrate: 9000, audioBitrate: 256 }, reason: 'user-override', injected: 'mitm' })
    expect(onQualityChange).not.toHaveBeenCalled()
    expect(session.profile.videoBitrate).toBe(8000) // unchanged sentinel from sessionInfo
  })

  it('drops a quality-changed with array reason and does not fire callback', async () => {
    const { onQualityChange } = makeSession()
    await flushMicrotasks()
    deliver({ type: 'quality-changed', profile: { videoBitrate: 9000, audioBitrate: 256 }, reason: ['x'] })
    expect(onQualityChange).not.toHaveBeenCalled()
  })

  it('does not fire any callback for a null/garbage message', async () => {
    const { onReady, onError, onWarning } = makeSession()
    await flushMicrotasks()
    const ws = FakeWebSocket.instances.at(-1)!
    ws.onmessage?.({ data: 'not json' })
    ws.onmessage?.({ data: JSON.stringify({ type: 'bogus' }) })
    expect(onReady).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(onWarning).not.toHaveBeenCalled()
  })
})
