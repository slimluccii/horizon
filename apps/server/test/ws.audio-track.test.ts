import { describe, it, expect } from 'vitest'
import { handleWsMessage } from '../src/ws/handler.ts'
import type { Session } from '../src/session/types.ts'
import type { SessionManager } from '../src/session/manager.ts'
import type { Config } from '../src/config.ts'
import type { HwAccel } from '../src/transcode/hwaccel.ts'

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
      renditions: [],
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

describe('WS audio-track bounds validation (#77)', () => {
  it('rejects an out-of-range audio-track index without mutating the session', () => {
    const { session, sent } = fakeSession({ audioTrackCount: 2 })
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
    handleWsMessage({ type: 'audio-track', index: -1, positionMs: 0 }, session, sessions, cfg, hwAccel)
    expect(sent).toHaveLength(0)
  })

  it('accepts an in-range audio-track index on direct-play (updates plan)', () => {
    const { session, sent } = fakeSession({ audioTrackCount: 2 })
    handleWsMessage({ type: 'audio-track', index: 1, positionMs: 0 }, session, sessions, cfg, hwAccel)
    expect(sent.find(f => f.type === 'error')).toBeUndefined()
    const changed = sent.find(f => f.type === 'track-changed')
    expect(changed?.audioTrackIndex).toBe(1)
    expect(session.plan.audioTrackIndex).toBe(1)
  })
})
