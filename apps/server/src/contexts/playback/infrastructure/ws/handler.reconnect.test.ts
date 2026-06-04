import { describe, it, expect, vi } from 'vitest'
import { handleWsMessage } from './handler.ts'
import type { Session } from '../../domain/types.ts'
import type { SessionManager } from '../../application/manager.ts'
import type { Config } from '../../../../platform/config/config.ts'
import type { HwAccel } from '../../domain/hwaccel.ts'

/** Captures frames written to the session's WS socket. */
function fakeSession(overrides: Partial<Session> = {}): { session: Session; sent: any[]; closed: { code: number; reason: string }[] } {
  const sent: any[] = []
  const closed: { code: number; reason: string }[] = []
  const session = {
    id: 'sess',
    mediaId: 'm1',
    filePath: '/x',
    state: 'detached',
    plan: {
      method: 'transcode',
      renditions: [{ profile: { name: '1080p', videoBitrate: 8000, audioBitrate: 192, width: 1920, height: 1080 } }],
    },
    selectedSubtitleTrack: null,
    renditionCodecs: [],
    sessionDir: '/x',
    sessionReady: false,
    durationSec: 100,
    currentStartSegment: 0,
    reconnectToken: 'real-token',
    seekPositionMs: 0,
    createdAt: 0,
    wsSocket: {
      send: (data: string) => sent.push(JSON.parse(data)),
      close: (code: number, reason: string) => closed.push({ code, reason }),
    } as any,
    ...overrides,
  } as Session
  return { session, sent, closed }
}

const sessions = { getRuntime: () => undefined } as unknown as SessionManager
const cfg = {} as Config
const hwAccel = {} as HwAccel

describe('WS hello handshake / reconnect (#74)', () => {
  it('responds with session-ready when client sends hello WITHOUT a reconnectToken (initial attach)', () => {
    const { session, sent } = fakeSession()
    handleWsMessage({ type: 'hello' }, session, sessions, cfg, hwAccel)
    expect(session.state).toBe('active')
    const ready = sent.find(f => f.type === 'session-ready')
    expect(ready).toBeTruthy()
    expect(ready.profile.videoBitrate).toBe(8000)
    expect(ready.reconnectToken).toBe('real-token')
  })

  it('reattaches and replies session-ready when client sends hello with the MATCHING token', () => {
    const { session, sent, closed } = fakeSession({ state: 'detached' })
    handleWsMessage({ type: 'hello', reconnectToken: 'real-token' }, session, sessions, cfg, hwAccel)
    expect(closed).toHaveLength(0)
    expect(session.state).toBe('active')
    expect(sent.find(f => f.type === 'session-ready')).toBeTruthy()
  })

  it('closes the socket with 4401 when the reconnectToken does not match', () => {
    const { session, sent, closed } = fakeSession()
    handleWsMessage({ type: 'hello', reconnectToken: 'forged' }, session, sessions, cfg, hwAccel)
    expect(closed).toEqual([{ code: 4401, reason: 'invalid-reconnect-token' }])
    expect(sent.find(f => f.type === 'session-ready')).toBeUndefined()
  })

  it('clears the grace timer on a successful hello', () => {
    const timer = setTimeout(() => {}, 10_000)
    const cleared = vi.fn()
    const { session } = fakeSession({ graceTimer: timer })
    const realClear = globalThis.clearTimeout
    globalThis.clearTimeout = ((t: any) => { cleared(); realClear(t) }) as any
    try {
      handleWsMessage({ type: 'hello' }, session, sessions, cfg, hwAccel)
      expect(cleared).toHaveBeenCalled()
    } finally {
      globalThis.clearTimeout = realClear
    }
  })
})
