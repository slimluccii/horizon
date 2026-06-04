import { describe, it, expect } from 'vitest'
import { handleWsMessage, isWsAuthenticated, resetWsAuth } from './handler.ts'
import type { Session } from '../../domain/types.ts'
import type { SessionManager } from '../../application/manager.ts'
import type { Config } from '../../../../config.ts'
import type { HwAccel } from '../../domain/hwaccel.ts'

/** Minimal Session double with a recording WS socket. */
function fakeSession(overrides: Partial<Session> = {}): {
  session: Session
  sent: any[]
  closed: { code: number; reason: string }[]
} {
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

describe('WS attach authentication gate (#56)', () => {
  it('drops non-hello commands before the hello handshake', () => {
    const { session, sent } = fakeSession()
    resetWsAuth(session)
    // A seek arriving before hello must be ignored: no state mutation, no reply.
    handleWsMessage({ type: 'seek', positionMs: 5000 }, session, sessions, cfg, hwAccel)
    expect(isWsAuthenticated(session)).toBe(false)
    expect(session.seekPositionMs).toBe(0)
    expect(sent).toHaveLength(0)
  })

  it('drops subtitle-track command before hello (no state change, no reply)', () => {
    const { session, sent } = fakeSession()
    resetWsAuth(session)
    handleWsMessage({ type: 'subtitle-track', index: 2 }, session, sessions, cfg, hwAccel)
    expect(session.selectedSubtitleTrack).toBeNull()
    expect(sent).toHaveLength(0)
  })

  it('closes the socket with 4401 when hello carries an invalid reconnectToken', () => {
    const { session, sent, closed } = fakeSession()
    resetWsAuth(session)
    handleWsMessage({ type: 'hello', reconnectToken: 'forged' }, session, sessions, cfg, hwAccel)
    expect(closed).toEqual([{ code: 4401, reason: 'invalid-reconnect-token' }])
    expect(isWsAuthenticated(session)).toBe(false)
    expect(sent.find(f => f.type === 'session-ready')).toBeUndefined()
  })

  it('authenticates on a valid hello and then accepts subsequent commands', () => {
    const { session, sent } = fakeSession()
    resetWsAuth(session)
    handleWsMessage({ type: 'hello', reconnectToken: 'real-token' }, session, sessions, cfg, hwAccel)
    expect(isWsAuthenticated(session)).toBe(true)
    expect(sent.find(f => f.type === 'session-ready')).toBeTruthy()
    // A subtitle-track command now takes effect and replies.
    handleWsMessage({ type: 'subtitle-track', index: 3 }, session, sessions, cfg, hwAccel)
    expect(session.selectedSubtitleTrack).toBe(3)
    expect(sent.find(f => f.type === 'track-changed' && f.subtitleTrackIndex === 3)).toBeTruthy()
  })

  it('authenticates on a tokenless initial-attach hello (preserves #74 contract)', () => {
    const { session } = fakeSession()
    resetWsAuth(session)
    handleWsMessage({ type: 'hello' }, session, sessions, cfg, hwAccel)
    expect(isWsAuthenticated(session)).toBe(true)
    // Commands flow after the tokenless handshake.
    handleWsMessage({ type: 'subtitle-track', index: 1 }, session, sessions, cfg, hwAccel)
    expect(session.selectedSubtitleTrack).toBe(1)
  })

  it('resetWsAuth re-locks the socket so a reconnecting client must re-hello', () => {
    const { session } = fakeSession()
    handleWsMessage({ type: 'hello' }, session, sessions, cfg, hwAccel)
    expect(isWsAuthenticated(session)).toBe(true)
    resetWsAuth(session)
    expect(isWsAuthenticated(session)).toBe(false)
    // Pre-hello command on the reconnected socket is dropped again — the
    // subtitle track stays at its initial value.
    handleWsMessage({ type: 'subtitle-track', index: 9 }, session, sessions, cfg, hwAccel)
    expect(session.selectedSubtitleTrack).toBeNull()
  })
})
