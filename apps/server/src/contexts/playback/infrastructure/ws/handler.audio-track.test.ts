import { describe, it, expect } from 'vitest'
import { handleWsMessage } from './handler.ts'
import type { Session } from '../../domain/types.ts'
import type { SessionManager } from '../../application/manager.ts'
import type { Config } from '../../../../config.ts'
import type { HwAccel } from '../../domain/hwaccel.ts'

function fakeSession(overrides: Partial<Session> = {}): { session: Session; sent: any[] } {
  const sent: any[] = []
  const session = {
    id: 'sess',
    mediaId: 'm1',
    filePath: '/x',
    state: 'active',
    plan: {
      method: 'direct-play',
      audioTrackIndex: 0,
      // One rendition so the `hello` handshake (which reads renditions[0].profile
      // when emitting session-ready) succeeds. Method stays direct-play.
      renditions: [{ profile: { name: 'src' } }],
    },
    selectedSubtitleTrack: null,
    audioTrackCount: 2,
    subtitleTrackCount: 0,
    renditionCodecs: [],
    sessionDir: '/x',
    sessionReady: true,
    durationSec: 100,
    currentStartSegment: 0,
    reconnectToken: 'tok',
    seekPositionMs: 0,
    createdAt: 0,
    wsSocket: { send: (data: string) => sent.push(JSON.parse(data)) } as any,
    ...overrides,
  } as Session
  return { session, sent }
}

const sessions = { getRuntime: () => undefined } as unknown as SessionManager
const cfg = {} as Config
const hwAccel = {} as HwAccel

// The WS auth gate drops every non-`hello` command until the socket completes
// the handshake. Real clients send `hello` first; the tests do the same so the
// audio-track commands are actually processed.
function authenticate(session: Session, sent: any[]) {
  handleWsMessage({ type: 'hello' }, session, sessions, cfg, hwAccel)
  // Drop any frames emitted by the handshake so assertions see only the
  // frames produced by the command under test.
  sent.length = 0
}

describe('WS audio-track bounds validation (#77)', () => {
  it('rejects an out-of-range audio-track index without mutating the session', () => {
    const { session, sent } = fakeSession({ audioTrackCount: 2 })
    authenticate(session, sent)
    const planBefore = session.plan
    handleWsMessage({ type: 'audio-track', index: 999, positionMs: 0 }, session, sessions, cfg, hwAccel)

    const err = sent.find(f => f.type === 'error')
    expect(err).toBeTruthy()
    expect(err.code).toBe('audio-track-invalid')
    // Session survives and the plan is untouched.
    expect(session.state).toBe('active')
    expect(session.plan).toBe(planBefore)
    expect(sent.find(f => f.type === 'track-changed')).toBeUndefined()
  })

  it('drops negative indices at the parser before the handler (defense in depth)', () => {
    // parseWsMessage rejects index < 0 outright, so no frame is processed and
    // the session is untouched. The handler bound-check guards the remaining
    // out-of-range (too-high) case.
    const { session, sent } = fakeSession({ audioTrackCount: 2 })
    authenticate(session, sent)
    handleWsMessage({ type: 'audio-track', index: -1, positionMs: 0 }, session, sessions, cfg, hwAccel)
    expect(sent).toHaveLength(0)
  })

  it('accepts an in-range audio-track index on direct-play (updates plan)', () => {
    const { session, sent } = fakeSession({ audioTrackCount: 2 })
    authenticate(session, sent)
    handleWsMessage({ type: 'audio-track', index: 1, positionMs: 0 }, session, sessions, cfg, hwAccel)
    expect(sent.find(f => f.type === 'error')).toBeUndefined()
    const changed = sent.find(f => f.type === 'track-changed')
    expect(changed?.audioTrackIndex).toBe(1)
    expect(session.plan.audioTrackIndex).toBe(1)
  })
})
