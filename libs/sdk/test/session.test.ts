import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PlaybackSession } from '../src/session.ts'
import type { SessionInfo } from '../src/types.ts'

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

const sessionInfo: SessionInfo = {
  sessionId: 's1',
  method: 'transcode',
  streamUrl: '/sessions/s1/stream.m3u8',
  wsUrl: '/sessions/s1/ws',
  profiles: [{ videoBitrate: 8000, audioBitrate: 192 }],
  selectedAudioTrack: 0,
  selectedSubtitleTrack: null,
}

function newSession() {
  return new PlaybackSession({
    sessionInfo,
    baseUrl: 'http://x',
    capabilities: { videoCodecs: [], audioCodecs: [], hdr: [], maxBitrate: 0, container: [] },
  })
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

function lastWs() { return FakeWebSocket.instances.at(-1)! }
function sentFrames() { return lastWs().sent.map(s => JSON.parse(s)) }

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true }) as unknown as Response))
})

afterEach(() => { vi.restoreAllMocks() })

describe('PlaybackSession hello handshake (#74)', () => {
  it('sends hello on initial onopen even when reconnectToken is null', async () => {
    newSession()
    await flush()
    lastWs().onopen?.()
    const hellos = sentFrames().filter(f => f.type === 'hello')
    expect(hellos).toHaveLength(1)
    expect('reconnectToken' in hellos[0]).toBe(false)
  })

  it('includes reconnectToken in hello once the server assigned one (on reconnect)', async () => {
    vi.useFakeTimers()
    try {
      const session = newSession()
      await Promise.resolve(); await Promise.resolve()
      lastWs().onopen?.()
      lastWs().onmessage?.({ data: JSON.stringify({ type: 'session-ready', profile: { videoBitrate: 8000, audioBitrate: 192 }, reconnectToken: 'tok-123' }) })
      expect(session.state).toBe('active')
      lastWs().onclose?.()
      await vi.advanceTimersByTimeAsync(2000)
      lastWs().onopen?.()
      const hellos = sentFrames().filter(f => f.type === 'hello')
      expect(hellos.at(-1)).toEqual({ type: 'hello', reconnectToken: 'tok-123' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('PlaybackSession.reconnectToken getter (#78)', () => {
  it('is null before session-ready arrives', async () => {
    const session = newSession()
    await flush()
    lastWs().onopen?.()
    // No session-ready yet → nothing for the player to put in X-Reconnect-Token.
    expect(session.reconnectToken).toBeNull()
  })

  it('exposes the server-assigned token after session-ready so the player can inject the X-Reconnect-Token header', async () => {
    const session = newSession()
    await flush()
    lastWs().onopen?.()
    lastWs().onmessage?.({ data: JSON.stringify({ type: 'session-ready', profile: { videoBitrate: 8000, audioBitrate: 192 }, reconnectToken: 'seg-tok' }) })
    expect(session.state).toBe('active')
    expect(session.reconnectToken).toBe('seg-tok')
  })
})
