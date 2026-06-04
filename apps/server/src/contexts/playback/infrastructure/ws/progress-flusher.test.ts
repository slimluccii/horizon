import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { openDatabase } from '../../../../db/index.ts'
import { migrate } from '../../../../db/migrations.ts'
import { createMediaRepo } from '../../../library/index.ts'
import { createUserRepo } from '../../../identity/index.ts'
import { createProgressRepo } from '../persistence/progress.ts'
import { createProgressFlusher } from './progress-flusher.ts'
import type { Session } from '../../domain/types.ts'

function fakeSession(overrides: Partial<Session>): Session {
  return {
    id: 'sess', mediaId: 'm1', filePath: '/x', state: 'active',
    method: 'transcode', capabilities: {} as any,
    selectedAudioTrack: 0, selectedSubtitleTrack: null,
    profiles: [], renditionCodecs: [], needsToneMap: false,
    toneMap: { operator: 'hable' } as any, sessionDir: '/x',
    sessionReady: true, durationSec: 100, currentStartSegment: 0,
    reconnectToken: 'tok', seekPositionMs: 0, createdAt: 0,
    ...overrides,
  } as Session
}

describe('progress flusher', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('flushes only on interval and on finalFlush', () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const media = createMediaRepo(db)
    const progress = createProgressRepo(db, media, { getWatchedThresholdPct: () => 90 })
    const u = users.create({ name: 'a' })
    media.upsertMovie({
      id: 'm1', filePath: '/x.mkv', title: 'x', sortYear: 2020,
      durationSec: 100, resolution: '1920x1080', videoCodec: 'h264', container: 'mkv',
      hdr: { dv: false, hdr10: false, hdr10plus: false },
      audioTracks: [], subtitleTracks: [], mtimeMs: 1, sizeBytes: 1,
      externalIds: {}, metadata: null,
    })

    const session = fakeSession({ userId: u.id, mediaId: 'm1' })
    const f = createProgressFlusher(session, progress)
    f.record(1000, 60_000)
    f.record(2000, 60_000)
    // No flush yet
    expect(progress.getProgress(u.id, 'm1')).toBeNull()
    vi.advanceTimersByTime(30_000)
    const p1 = progress.getProgress(u.id, 'm1')
    expect(p1?.positionMs).toBe(2000)
    f.record(3000, 60_000)
    f.finalFlush()
    expect(progress.getProgress(u.id, 'm1')?.positionMs).toBe(3000)
    f.stop()
  })

  it('does nothing when userId is absent', () => {
    const db = openDatabase(':memory:'); migrate(db)
    createUserRepo(db)
    const media = createMediaRepo(db)
    const progress = createProgressRepo(db, media, { getWatchedThresholdPct: () => 90 })
    const session = fakeSession({}) // no userId
    const f = createProgressFlusher(session, progress)
    f.record(1000, 60_000)
    vi.advanceTimersByTime(30_000)
    f.finalFlush()
    // no rows inserted
    expect((db.prepare('SELECT COUNT(*) as c FROM watch_progress').get() as any).c).toBe(0)
    f.stop()
  })
})
