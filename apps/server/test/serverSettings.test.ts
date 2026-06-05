import { describe, it, expect, vi } from 'vitest'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createServerSettings } from '../src/repos/serverSettings.ts'
import { createProgressRepo } from '../src/repos/progress.ts'
import { createUserRepo } from '../src/repos/users.ts'
import { createMediaRepo } from '../src/repos/media.ts'
import type { Config } from '../src/config.ts'

function freshDb() {
  const db = openDatabase(':memory:')
  migrate(db)
  return db
}

function readRow(db: ReturnType<typeof openDatabase>) {
  return db.prepare('SELECT * FROM server_settings WHERE id = 1').get() as Record<string, unknown>
}

/** Minimal Config with the values used by bootstrapFromEnv */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 7777,
    corsOrigins: ['*'],
    cacheDir: '/tmp',
    dbPath: ':memory:',
    watchedThresholdPct: 90,
    maxSessions: 4,
    wsGraceMs: 10_000,
    wsAttachMs: 10_000,
    maxRenditions: 3,
    forceEncoder: undefined,
    tmdbToken: undefined,
    toneMap: { operator: 'hable', param: undefined, desat: undefined, peak: undefined, postCorrection: true },
    scanConcurrency: 4,
    scanCronHour: 3,
    watchFs: false,
    watchDebounceMs: 5_000,
    metadataBatchSize: 50,
    metadataMaxAgeMovieMs: 30 * 86_400_000,
    metadataMaxAgeShowMs: 7 * 86_400_000,
    metadataMaxAgeEpisodeMs: 60 * 86_400_000,
    devSeedEnabled: false,
    nodeEnv: 'development',
    webDir: undefined,
    serveWeb: false,
    serverName: undefined,
    mdnsEnabled: true,
    ...overrides,
  }
}

describe('bootstrapFromEnv', () => {
  it('fresh install — sets seeded_from_env=1 with defaults from config', () => {
    const db = freshDb()
    const ss = createServerSettings(db)
    ss.bootstrapFromEnv(makeConfig())
    const row = readRow(db)
    expect(row.seeded_from_env).toBe(1)
    expect(row.watched_threshold_pct).toBe(90)
    expect(row.max_sessions).toBe(4)
    expect(row.watch_fs).toBe(0)
    expect(row.scan_concurrency).toBe(4)
  })

  it('config overrides — applied when seeded_from_env=0', () => {
    const db = freshDb()
    const ss = createServerSettings(db)
    ss.bootstrapFromEnv(makeConfig({
      watchedThresholdPct: 75,
      maxSessions: 8,
      watchFs: true,
      metadataMaxAgeMovieMs: 14 * 86_400_000,
    }))
    const row = readRow(db)
    expect(row.watched_threshold_pct).toBe(75)
    expect(row.max_sessions).toBe(8)
    expect(row.watch_fs).toBe(1)
    expect(row.metadata_max_age_movie_days).toBe(14)
    expect(row.scan_concurrency).toBe(4)
    expect(row.seeded_from_env).toBe(1)
  })

  it('second boot — already seeded, ignores config changes', () => {
    const db = freshDb()
    const ss = createServerSettings(db)
    ss.bootstrapFromEnv(makeConfig({ watchedThresholdPct: 75 }))
    ss.bootstrapFromEnv(makeConfig({ watchedThresholdPct: 50 }))
    const row = readRow(db)
    expect(row.watched_threshold_pct).toBe(75)
  })
})

describe('createServerSettings', () => {
  it('get() returns typed live row with correct JS types', () => {
    const db = freshDb()
    const ss = createServerSettings(db)
    ss.bootstrapFromEnv(makeConfig())
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
    const ss = createServerSettings(db)
    ss.bootstrapFromEnv(makeConfig())
    ss.update({ watchedThresholdPct: 60 })
    expect(ss.get().watchedThresholdPct).toBe(60)
    const row = readRow(db)
    expect(row.watched_threshold_pct).toBe(60)
  })

  it('update emits change event with patch', () => {
    const db = freshDb()
    const ss = createServerSettings(db)
    ss.bootstrapFromEnv(makeConfig())
    const spy = vi.fn()
    ss.on('change', spy)
    ss.update({ watchedThresholdPct: 60, maxSessions: 2 })
    expect(spy).toHaveBeenCalledOnce()
    const event = spy.mock.calls[0][0]
    expect(event.patch).toMatchObject({ watchedThresholdPct: 60, maxSessions: 2 })
  })

  it('off() stops receiving events', () => {
    const db = freshDb()
    const ss = createServerSettings(db)
    ss.bootstrapFromEnv(makeConfig())
    const spy = vi.fn()
    ss.on('change', spy)
    ss.off('change', spy)
    ss.update({ watchedThresholdPct: 80 })
    expect(spy).not.toHaveBeenCalled()
  })

  it('passive consumer sees new values via getWatchedThresholdPct thunk', () => {
    const db = freshDb()
    const ss = createServerSettings(db)
    ss.bootstrapFromEnv(makeConfig())
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
