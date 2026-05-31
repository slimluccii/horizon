import { describe, it, expect, vi, afterEach } from 'vitest'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createServerSettings } from '../src/repos/serverSettings.ts'
import { createSessionManager } from '../src/session/manager.ts'
import type { Session } from '../src/session/types.ts'

// Minimal Session partial — the manager only spreads these fields and arms the
// attach timer; the exact plan/track values are irrelevant to this test.
function partial(): Omit<Session, 'id' | 'reconnectToken' | 'createdAt' | 'state' | 'seekPositionMs' | 'currentStartSegment'> {
  return {
    mediaId: 'm1',
    filePath: '/m/m1.mkv',
    plan: { method: 'direct' } as any,
    selectedSubtitleTrack: null,
    audioTrackCount: 1,
    subtitleTrackCount: 0,
    renditionCodecs: [],
    sessionDir: '/tmp/s',
    sessionReady: false,
    durationSec: 100,
  } as any
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SessionManager.create — wsAttachMs is read live (#65)', () => {
  it('a session created after PATCH wsAttachMs uses the new attach-timeout value', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const serverSettings = createServerSettings(db)
    const sessions = createSessionManager(serverSettings)

    // Capture the delay passed to setTimeout when arming the attach timer.
    const delays: number[] = []
    const realSetTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number, ...rest: any[]) => {
      delays.push(ms ?? 0)
      // Don't actually schedule — we only care about the delay, and we destroy
      // the sessions immediately after so no real timer fires.
      return realSetTimeout(() => {}, 1_000_000) as any
    }) as any)

    const initial = serverSettings.get().wsAttachMs
    const s1 = sessions.create(partial())
    expect(delays.at(-1)).toBe(initial)
    void sessions.destroy(s1.id)

    // Operator changes the attach timeout live.
    const newValue = initial + 5_000
    serverSettings.update({ wsAttachMs: newValue })

    const s2 = sessions.create(partial())
    expect(delays.at(-1)).toBe(newValue)
    void sessions.destroy(s2.id)
  })
})
