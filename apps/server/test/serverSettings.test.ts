import { describe, it, expect, vi } from 'vitest'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createServerSettings, bootstrapFromEnv } from '../src/serverSettings.ts'
import { createProgressRepo } from '../src/repos/progress.ts'
import { createUserRepo } from '../src/repos/users.ts'
import { createMediaRepo } from '../src/repos/media.ts'

function freshDb() {
  const db = openDatabase(':memory:')
  migrate(db)
  return db
}

function readRow(db: ReturnType<typeof openDatabase>) {
  return db.prepare('SELECT * FROM server_settings WHERE id = 1').get() as Record<string, number>
}

describe('bootstrapFromEnv', () => {
  it('fresh install — no envs set — sets seeded_from_env=1 with all defaults', () => {
    const db = freshDb()
    bootstrapFromEnv(db, {})
    const row = readRow(db)
    expect(row.seeded_from_env).toBe(1)
    expect(row.watched_threshold_pct).toBe(90)
    expect(row.max_sessions).toBe(4)
    expect(row.watch_fs).toBe(0)
    expect(row.scan_concurrency).toBe(4)
  })

  it('upgrade — envs override defaults, flag flips to 1', () => {
    const db = freshDb()
    bootstrapFromEnv(db, {
      HORIZON_WATCHED_THRESHOLD_PCT: '75',
      HORIZON_MAX_SESSIONS: '8',
      HORIZON_WATCH_FS: '1',
      HORIZON_METADATA_MAX_AGE_MOVIE_DAYS: '14',
    })
    const row = readRow(db)
    expect(row.watched_threshold_pct).toBe(75)
    expect(row.max_sessions).toBe(8)
    expect(row.watch_fs).toBe(1)
    expect(row.metadata_max_age_movie_days).toBe(14)
    expect(row.scan_concurrency).toBe(4)
    expect(row.seeded_from_env).toBe(1)
  })

  it('second boot — ignores env even if changed', () => {
    const db = freshDb()
    bootstrapFromEnv(db, { HORIZON_WATCHED_THRESHOLD_PCT: '75' })
    bootstrapFromEnv(db, { HORIZON_WATCHED_THRESHOLD_PCT: '50' })
    const row = readRow(db)
    expect(row.watched_threshold_pct).toBe(75)
  })

  it('invalid env values fall back to default', () => {
    const db = freshDb()
    bootstrapFromEnv(db, { HORIZON_WATCHED_THRESHOLD_PCT: 'banana' })
    const row = readRow(db)
    expect(row.watched_threshold_pct).toBe(90)
    expect(row.seeded_from_env).toBe(1)
  })

  it('empty env string treated as unset', () => {
    const db = freshDb()
    bootstrapFromEnv(db, { HORIZON_WATCHED_THRESHOLD_PCT: '' })
    const row = readRow(db)
    expect(row.watched_threshold_pct).toBe(90)
    expect(row.seeded_from_env).toBe(1)
  })
})

describe('createServerSettings', () => {
  it('get() returns typed live row with correct JS types', () => {
    const db = freshDb()
    bootstrapFromEnv(db, {})
    const ss = createServerSettings(db)
    const vals = ss.get()
    expect(typeof vals.watchedThresholdPct).toBe('number')
    expect(typeof vals.watchFs).toBe('boolean')
    expect(typeof vals.scanConcurrency).toBe('number')
    expect(vals.watchedThresholdPct).toBe(90)
    expect(vals.watchFs).toBe(false)
    expect(vals.maxSessions).toBe(4)
  })

  it('update(patch) writes back and get() reflects new value', () => {
    const db = freshDb()
    bootstrapFromEnv(db, {})
    const ss = createServerSettings(db)
    ss.update({ watchedThresholdPct: 60 })
    expect(ss.get().watchedThresholdPct).toBe(60)
    const row = readRow(db)
    expect(row.watched_threshold_pct).toBe(60)
  })

  it('update emits typed change event with diff', () => {
    const db = freshDb()
    bootstrapFromEnv(db, {})
    const ss = createServerSettings(db)
    const spy = vi.fn()
    ss.on('change', spy)
    ss.update({ watchedThresholdPct: 60, maxSessions: 2 })
    expect(spy).toHaveBeenCalledOnce()
    const change = spy.mock.calls[0][0]
    expect(change.diff).toEqual({ watchedThresholdPct: 60, maxSessions: 2 })
    expect(change.prev.watchedThresholdPct).toBe(90)
    expect(change.next.watchedThresholdPct).toBe(60)
    expect(change.prev.maxSessions).toBe(4)
    expect(change.next.maxSessions).toBe(2)
  })

  it('update rejects unknown keys', () => {
    const db = freshDb()
    bootstrapFromEnv(db, {})
    const ss = createServerSettings(db)
    expect(() => ss.update({ notAColumn: 1 } as any)).toThrow()
  })

  it('on() returns unsubscribe thunk — spy not called after unsubscribe', () => {
    const db = freshDb()
    bootstrapFromEnv(db, {})
    const ss = createServerSettings(db)
    const spy = vi.fn()
    const off = ss.on('change', spy)
    off()
    ss.update({ watchedThresholdPct: 80 })
    expect(spy).not.toHaveBeenCalled()
  })

  it('passive consumer sees new values via getWatchedThresholdPct thunk', () => {
    const db = freshDb()
    bootstrapFromEnv(db, {})
    const ss = createServerSettings(db)
    const users = createUserRepo(db)
    const media = createMediaRepo(db)
    const progress = createProgressRepo(db, media, {
      getWatchedThresholdPct: () => ss.get().watchedThresholdPct,
    })

    const u = users.create({ name: 'u' })
    media.upsertMovie({
      id: 'm1', filePath: '/m1.mkv', title: 'M', sortYear: 2020,
      durationSec: 10_000, resolution: '1920x1080', videoCodec: 'h264', container: 'mkv',
      hdr: { dv: false, hdr10: false, hdr10plus: false },
      audioTracks: [], subtitleTracks: [], mtimeMs: 1, sizeBytes: 1,
      externalIds: {}, metadata: null,
    })

    // 80% of 10,000,000ms — below 90% threshold, well above 30s tail rule
    const p1 = progress.setProgress(u.id, 'm1', { positionMs: 8_000_000, durationMs: 10_000_000 })
    expect(p1.watched).toBe(false)

    ss.update({ watchedThresholdPct: 70 })

    const p2 = progress.setProgress(u.id, 'm1', { positionMs: 8_000_000, durationMs: 10_000_000 })
    expect(p2.watched).toBe(true)
  })
})
