import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { openDatabase, type DatabaseSync } from '../../../../db/index.ts'
import { migrate } from '../../../../db/migrations.ts'
import { createUserRepo } from '../../../identity/index.ts'
import { createSessionRepo } from '../../../identity/index.ts'
import { makeRequireAuth } from '../../../identity/index.ts'
import { createServerSettings } from '../persistence/serverSettings.ts'
import { createSessionManager } from '../../../../session/manager.ts'
import { createMetadataRefreshWorker, DEFAULT_REFRESH_CONFIG } from '../../../metadata/index.ts'
import { createChangesCursorRepo } from '../../../../repos/scanState.ts'
import { createMediaRepo } from '../../../../repos/media.ts'
import { registerSettings } from './settings.ts'
import type { ServerSettings } from '../persistence/serverSettings.ts'
import type { TmdbProvider } from '../../../metadata/index.ts'

function setup() {
  const db = openDatabase(':memory:')
  migrate(db)
  const users = createUserRepo(db)
  const serverSettings = createServerSettings(db)
  const owner = users.create({ name: 'Alice' })          // auto-elected owner
  const admin = users.update(
    users.create({ name: 'Bob' }).id,
    { role: 'admin' },
  )!
  const member = users.create({ name: 'Carol' })          // default member
  return { db, users, serverSettings, owner, admin, member }
}

async function buildApp(
  db: DatabaseSync,
  users: ReturnType<typeof setup>['users'],
  serverSettings: ServerSettings,
) {
  const app = Fastify({ logger: false })
  // registerSettings needs a cfg object; roots are no longer base-confined, none of the
  // tests in this file patch roots, so a placeholder base is sufficient.
  const cfg = {} as unknown as import('../../../../config.ts').Config
  app.addHook('onRequest', makeRequireAuth(createSessionRepo(db), users))
  registerSettings(app, users, serverSettings, cfg)
  await app.ready()
  return app
}

/** Session bearer header for a user id. */
function hdr(db: DatabaseSync, userId: string): { authorization: string } {
  return { authorization: `Bearer ${createSessionRepo(db).issue(userId).token}` }
}

describe('GET /settings/server', () => {
  it('returns the live row to any authenticated user', async () => {
    const { db, users, serverSettings, member } = setup()
    const app = await buildApp(db, users, serverSettings)
    const res = await app.inject({
      method: 'GET', url: '/settings/server',
      headers: hdr(db, member.id),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('watchedThresholdPct')
    expect(body).toHaveProperty('scanCronHour')
    expect(body).toHaveProperty('watchFs')
    expect(body).toHaveProperty('watchDebounceMs')
  })

  it('masks tmdbToken as "unset" when not set', async () => {
    const { db, users, serverSettings, member } = setup()
    const app = await buildApp(db, users, serverSettings)
    const res = await app.inject({
      method: 'GET', url: '/settings/server',
      headers: hdr(db, member.id),
    })
    expect(res.json().tmdbToken).toBe('unset')
  })

  it('masks tmdbToken as "set" when a token is present', async () => {
    const { db, users, serverSettings, owner } = setup()
    serverSettings.update({ tmdbToken: 'abc-secret' })
    const app = await buildApp(db, users, serverSettings)
    const res = await app.inject({
      method: 'GET', url: '/settings/server',
      headers: hdr(db, owner.id),
    })
    expect(res.json().tmdbToken).toBe('set')
  })

  it('rejects with 401 when unauthenticated', async () => {
    const { db, users, serverSettings } = setup()
    const app = await buildApp(db, users, serverSettings)
    const res = await app.inject({ method: 'GET', url: '/settings/server' })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthorized')
  })

  it('does not leak seededFromEnv', async () => {
    const { db, users, serverSettings, member } = setup()
    const app = await buildApp(db, users, serverSettings)
    const res = await app.inject({
      method: 'GET', url: '/settings/server',
      headers: hdr(db, member.id),
    })
    expect(res.json()).not.toHaveProperty('seededFromEnv')
  })
})

describe('PATCH /settings/server — role gate', () => {
  it('owner can PATCH', async () => {
    const { db, users, serverSettings, owner } = setup()
    const app = await buildApp(db, users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: hdr(db, owner.id),
      payload: { watchedThresholdPct: 85 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().watchedThresholdPct).toBe(85)
  })

  it('admin can PATCH', async () => {
    const { db, users, serverSettings, admin } = setup()
    const app = await buildApp(db, users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: hdr(db, admin.id),
      payload: { scanCronHour: 4 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().scanCronHour).toBe(4)
  })

  it('member is rejected with 403', async () => {
    const { db, users, serverSettings, member } = setup()
    const app = await buildApp(db, users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: hdr(db, member.id),
      payload: { watchedThresholdPct: 50 },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
  })

  it('unauthenticated PATCH is rejected with 401', async () => {
    const { db, users, serverSettings } = setup()
    const app = await buildApp(db, users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      payload: { watchedThresholdPct: 50 },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthorized')
  })
})

describe('PATCH /settings/server — validation', () => {
  it('rejects unknown keys (strict schema)', async () => {
    const { db, users, serverSettings, owner } = setup()
    const app = await buildApp(db, users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: hdr(db, owner.id),
      payload: { unknownField: 'oops' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('rejects scanCronHour out of range', async () => {
    const { db, users, serverSettings, owner } = setup()
    const app = await buildApp(db, users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: hdr(db, owner.id),
      payload: { scanCronHour: 25 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects watchedThresholdPct out of range', async () => {
    const { db, users, serverSettings, owner } = setup()
    const app = await buildApp(db, users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: hdr(db, owner.id),
      payload: { watchedThresholdPct: 0 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('accepts empty patch (no-op)', async () => {
    const { db, users, serverSettings, owner } = setup()
    const app = await buildApp(db, users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: hdr(db, owner.id),
      payload: {},
    })
    expect(res.statusCode).toBe(200)
  })

  it('rejects maxSessions <= 0', async () => {
    const { db, users, serverSettings, owner } = setup()
    const app = await buildApp(db, users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: hdr(db, owner.id),
      payload: { maxSessions: 0 },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('rejects maxRenditions <= 0', async () => {
    const { db, users, serverSettings, owner } = setup()
    const app = await buildApp(db, users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: hdr(db, owner.id),
      payload: { maxRenditions: 0 },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('rejects maxSessions above hard cap', async () => {
    const { db, users, serverSettings, owner } = setup()
    const app = await buildApp(db, users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: hdr(db, owner.id),
      payload: { maxSessions: 100 },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })
})

describe('serverSettings — change events', () => {
  it('emits change event with diff when update is called', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const serverSettings = createServerSettings(db)

    const events: Array<{ patch: object }> = []
    serverSettings.on('change', ev => events.push(ev))

    serverSettings.update({ scanCronHour: 5 })

    expect(events).toHaveLength(1)
    expect(events[0].patch).toMatchObject({ scanCronHour: 5 })
  })

  it('update persists and get() returns the new value', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const serverSettings = createServerSettings(db)

    serverSettings.update({ watchFs: true, watchDebounceMs: 3000 })
    const row = serverSettings.get()

    expect(row.watchFs).toBe(true)
    expect(row.watchDebounceMs).toBe(3000)
  })
})

describe('serverSettings — bootstrapFromEnv', () => {
  it('overlays env config on first boot (seeded_from_env=0)', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const serverSettings = createServerSettings(db)

    // Simulate a Config with custom values
    serverSettings.bootstrapFromEnv({
      watchedThresholdPct: 80,
      scanCronHour: 2,
      scanConcurrency: 8,
      watchFs: true,
      watchDebounceMs: 2000,
      tmdbToken: 'env-token',
      metadataBatchSize: 100,
      metadataMaxAgeMovieMs: 15 * 86_400_000,
      metadataMaxAgeShowMs: 3 * 86_400_000,
      metadataMaxAgeEpisodeMs: 30 * 86_400_000,
      maxSessions: 2,
      maxRenditions: 2,
      wsGraceMs: 5000,
      wsAttachMs: 5000,
      forceEncoder: 'libx264',
      // Other Config fields not used by bootstrap:
      port: 7777,
      corsOrigins: ['*'],
      cacheDir: '/tmp',
      dbPath: ':memory:',
      devSeedEnabled: false,
      nodeEnv: 'development',
      webDir: undefined,
      serveWeb: false,
      toneMap: { operator: 'hable', param: undefined, desat: undefined, peak: undefined, postCorrection: true },
    } as import('../../../../config.ts').Config)

    const row = serverSettings.get()
    expect(row.watchedThresholdPct).toBe(80)
    expect(row.scanCronHour).toBe(2)
    expect(row.watchFs).toBe(true)
    expect(row.seededFromEnv).toBe(true)
  })

  it('does NOT re-overlay on second boot (seeded_from_env=1)', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const serverSettings = createServerSettings(db)

    const cfg = {
      watchedThresholdPct: 80,
      scanCronHour: 2,
      scanConcurrency: 4,
      watchFs: false,
      watchDebounceMs: 5000,
      tmdbToken: undefined,
      metadataBatchSize: 50,
      metadataMaxAgeMovieMs: 30 * 86_400_000,
      metadataMaxAgeShowMs: 7 * 86_400_000,
      metadataMaxAgeEpisodeMs: 60 * 86_400_000,
      maxSessions: 4,
      maxRenditions: 3,
      wsGraceMs: 10000,
      wsAttachMs: 10000,
      forceEncoder: undefined,
      port: 7777,
      corsOrigins: ['*'],
      cacheDir: '/tmp',
      dbPath: ':memory:',
      devSeedEnabled: false,
      nodeEnv: 'development',
      webDir: undefined,
      serveWeb: false,
      toneMap: { operator: 'hable', param: undefined, desat: undefined, peak: undefined, postCorrection: true },
    } as import('../../../../config.ts').Config

    serverSettings.bootstrapFromEnv(cfg)
    // Now manually change the DB value
    serverSettings.update({ watchedThresholdPct: 95 })
    // Re-bootstrap with different env value should NOT overwrite
    serverSettings.bootstrapFromEnv({ ...cfg, watchedThresholdPct: 50 })

    const row = serverSettings.get()
    expect(row.watchedThresholdPct).toBe(95)   // unchanged
  })
})

describe('PATCH /settings/server — playback knobs', () => {
  it('persists maxSessions and get() reflects new value', async () => {
    const { db, users, serverSettings, owner } = setup()
    const app = await buildApp(db, users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: hdr(db, owner.id),
      payload: { maxSessions: 8 },
    })
    expect(res.statusCode).toBe(200)
    expect(serverSettings.get().maxSessions).toBe(8)
  })

  it('persists tonemapOperator and get() reflects new value', async () => {
    const { db, users, serverSettings, owner } = setup()
    const app = await buildApp(db, users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: hdr(db, owner.id),
      payload: { tonemapOperator: 'mobius' },
    })
    expect(res.statusCode).toBe(200)
    expect(serverSettings.get().tonemapOperator).toBe('mobius')
  })

  it('persists tonemapParam and tonemapDesat', async () => {
    const { db, users, serverSettings, owner } = setup()
    const app = await buildApp(db, users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: hdr(db, owner.id),
      payload: { tonemapParam: 0.5, tonemapDesat: 0.3 },
    })
    expect(res.statusCode).toBe(200)
    const row = serverSettings.get()
    expect(row.tonemapParam).toBeCloseTo(0.5)
    expect(row.tonemapDesat).toBeCloseTo(0.3)
  })

  it('SessionManager reads maxSessions live — new limit takes effect immediately', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const serverSettings = createServerSettings(db)

    // Start with maxSessions=1
    serverSettings.update({ maxSessions: 1 })
    const sessions = createSessionManager(serverSettings)

    // Exhaust the first slot
    sessions.create({
      mediaId: 'm1', filePath: '/f.mkv',
      plan: {
        method: 'direct-play', needsToneMap: false,
        toneMap: { operator: 'hable', postCorrection: true },
        renditions: [], audioTrackIndex: 0,
        audioStrategy: 'copy', videoStrategy: 'copy',
      },
      renditionCodecs: [], sessionDir: '', sessionReady: false,
      durationSec: 0, userId: undefined, selectedSubtitleTrack: null,
      audioTrackCount: 0, subtitleTrackCount: 0,
    })

    // Second create should fail at limit=1
    expect(() => sessions.create({
      mediaId: 'm2', filePath: '/g.mkv',
      plan: {
        method: 'direct-play', needsToneMap: false,
        toneMap: { operator: 'hable', postCorrection: true },
        renditions: [], audioTrackIndex: 0,
        audioStrategy: 'copy', videoStrategy: 'copy',
      },
      renditionCodecs: [], sessionDir: '', sessionReady: false,
      durationSec: 0, userId: undefined, selectedSubtitleTrack: null,
      audioTrackCount: 0, subtitleTrackCount: 0,
    })).toThrow(expect.objectContaining({ code: 'max-sessions' }))

    // Raise the limit live — no restart
    serverSettings.update({ maxSessions: 4 })

    // Now the create succeeds
    expect(() => sessions.create({
      mediaId: 'm2', filePath: '/g.mkv',
      plan: {
        method: 'direct-play', needsToneMap: false,
        toneMap: { operator: 'hable', postCorrection: true },
        renditions: [], audioTrackIndex: 0,
        audioStrategy: 'copy', videoStrategy: 'copy',
      },
      renditionCodecs: [], sessionDir: '', sessionReady: false,
      durationSec: 0, userId: undefined, selectedSubtitleTrack: null,
      audioTrackCount: 0, subtitleTrackCount: 0,
    })).not.toThrow()
  })
})

describe('PATCH /settings/server — tmdbToken', () => {
  it('empty string normalises to unset (clears the token)', async () => {
    const { db, users, serverSettings, owner } = setup()
    // Pre-seed a token.
    serverSettings.update({ tmdbToken: 'abc-secret' })
    const app = await buildApp(db, users, serverSettings)

    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: hdr(db, owner.id),
      payload: { tmdbToken: '' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().tmdbToken).toBe('unset')

    // DB row should have null.
    expect(serverSettings.get().tmdbToken).toBeNull()
  })

  // A syntactically valid (mock) TMDB v4 JWT — header.payload.signature, all
  // base64url, comfortably over the 48-char minimum.
  const VALID_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJ0ZXN0IiwibmJmIjoxNzAwMDAwMDAwfQ.c2lnbmF0dXJlc2lnbmF0dXJlc2lnbmF0dXJl'

  it('valid JWT-format token saves and returns "set"', async () => {
    const { db, users, serverSettings, owner } = setup()
    const app = await buildApp(db, users, serverSettings)

    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: hdr(db, owner.id),
      payload: { tmdbToken: VALID_JWT },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().tmdbToken).toBe('set')
  })

  it('rejects a non-JWT token with 400 invalid-input (#76)', async () => {
    const { db, users, serverSettings, owner } = setup()
    const app = await buildApp(db, users, serverSettings)

    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: hdr(db, owner.id),
      payload: { tmdbToken: 'not-a-valid-token' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('rejects a too-short token with 400 invalid-input (#76)', async () => {
    const { db, users, serverSettings, owner } = setup()
    const app = await buildApp(db, users, serverSettings)

    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: hdr(db, owner.id),
      payload: { tmdbToken: 'a.b.c' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('GET never leaks the actual token value', async () => {
    const { db, users, serverSettings, owner } = setup()
    serverSettings.update({ tmdbToken: 'super-secret-token' })
    const app = await buildApp(db, users, serverSettings)

    const res = await app.inject({
      method: 'GET', url: '/settings/server',
      headers: hdr(db, owner.id),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.tmdbToken).toBe('set')
    expect(JSON.stringify(body)).not.toContain('super-secret-token')
  })
})

describe('PATCH /settings/server — metadata fields', () => {
  it('metadataBatchSize persists and is readable', async () => {
    const { db, users, serverSettings, owner } = setup()
    const app = await buildApp(db, users, serverSettings)

    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: hdr(db, owner.id),
      payload: { metadataBatchSize: 75 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().metadataBatchSize).toBe(75)
    expect(serverSettings.get().metadataBatchSize).toBe(75)
  })

  it('metadataMaxAgeMovieDays persists', async () => {
    const { db, users, serverSettings, owner } = setup()
    const app = await buildApp(db, users, serverSettings)

    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: hdr(db, owner.id),
      payload: { metadataMaxAgeMovieDays: 14 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().metadataMaxAgeMovieDays).toBe(14)
  })

  it('metadataMaxAgeShowDays and metadataMaxAgeEpDays persist', async () => {
    const { db, users, serverSettings, owner } = setup()
    const app = await buildApp(db, users, serverSettings)

    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: hdr(db, owner.id),
      payload: { metadataMaxAgeShowDays: 3, metadataMaxAgeEpDays: 45 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().metadataMaxAgeShowDays).toBe(3)
    expect(res.json().metadataMaxAgeEpDays).toBe(45)
  })

  it('PATCH metadataBatchSize is reflected in the next MetadataRefreshWorker run (#61/#65)', async () => {
    const { db, users, serverSettings, owner } = setup()
    const app = await buildApp(db, users, serverSettings)

    // The worker reads config from the SAME serverSettings the route mutates,
    // via a live getter — so a PATCH propagates to the next run().
    const wdb = openDatabase(':memory:')
    migrate(wdb)
    const media = createMediaRepo(wdb)
    for (let i = 0; i < 10; i++) {
      wdb.prepare(
        `INSERT INTO media_items (id, kind, title, file_path, mtime_ms, size_bytes,
                                  first_seen_at, last_seen_at, tmdb_id)
         VALUES (?, 'movie', ?, ?, 0, 0, 0, 0, ?)`,
      ).run(`m${i}`, `T${i}`, `/m/${i}.mkv`, 200 + i)
    }
    const tmdb: TmdbProvider = {
      async movieByTmdbId(id: number) { return { kind: 'movie', tmdbId: id, title: `M${id}` } as any },
      async movieByImdbId() { return null },
      async searchMovie() { return null },
      async showByTmdbId() { return null },
      async showByTvdbId() { return null },
      async searchShow() { return null },
      async episode() { return null },
      async changedMovieIds() { return [] },
      async changedShowIds() { return [] },
    } as any
    const DAY_MS = 86_400_000
    const worker = createMetadataRefreshWorker(
      () => ({
        ...DEFAULT_REFRESH_CONFIG,
        changesFeedExtraCap: 0,
        batchSize: serverSettings.get().metadataBatchSize,
        maxAgeMs: {
          movie: serverSettings.get().metadataMaxAgeMovieDays * DAY_MS,
          show: serverSettings.get().metadataMaxAgeShowDays * DAY_MS,
          episode: serverSettings.get().metadataMaxAgeEpDays * DAY_MS,
        },
      }),
      { media, tmdb, changesCursor: createChangesCursorRepo(wdb) },
    )

    // Shrink the batch size over HTTP, then run — the worker must honor it.
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: hdr(db, owner.id),
      payload: { metadataBatchSize: 4 },
    })
    expect(res.statusCode).toBe(200)
    const r = await worker.run({ useChangesFeed: false })
    expect(r.refreshed).toBe(4)
  })
})

describe('MetadataRefreshWorker — setTmdb (hot-swap)', () => {
  function fakeTmdb(label: string): TmdbProvider & { _calls: string[] } {
    const calls: string[] = []
    return {
      _calls: calls,
      async movieByTmdbId(id: number) { calls.push(`${label}:movie:${id}`); return { kind: 'movie', tmdbId: id, title: `Movie ${id}` } as any },
      async movieByImdbId() { return null },
      async searchMovie() { return null },
      async showByTmdbId() { return null },
      async showByTvdbId() { return null },
      async searchShow() { return null },
      async episode() { return null },
      async changedMovieIds() { return [] },
      async changedShowIds() { return [] },
    } as any
  }

  it('uses the new client after setTmdb is called', async () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const media = createMediaRepo(db)
    db.prepare(
      `INSERT INTO media_items (id, kind, title, file_path, mtime_ms, size_bytes,
                                first_seen_at, last_seen_at, tmdb_id)
       VALUES ('m1', 'movie', 'Test', '/m/test.mkv', 0, 0, 0, 0, 99)`,
    ).run()

    const tmdb1 = fakeTmdb('first')
    const worker = createMetadataRefreshWorker(
      { ...DEFAULT_REFRESH_CONFIG, batchSize: 5, changesFeedExtraCap: 5 },
      { media, tmdb: tmdb1, changesCursor: createChangesCursorRepo(db) },
    )

    await worker.run({ useChangesFeed: false })
    expect(tmdb1._calls.some(c => c.startsWith('first:'))).toBe(true)

    // Swap client and reset the metadata_fetched_at so the item is stale again.
    const tmdb2 = fakeTmdb('second')
    worker.setTmdb(tmdb2)
    db.prepare('UPDATE media_items SET metadata_fetched_at = NULL WHERE id = ?').run('m1')

    await worker.run({ useChangesFeed: false })
    expect(tmdb2._calls.some(c => c.startsWith('second:'))).toBe(true)
    // First client received no additional calls after swap.
    const firstCallCount = tmdb1._calls.length
    await worker.run({ useChangesFeed: false })
    expect(tmdb1._calls.length).toBe(firstCallCount)
  })

  it('run returns zero counts when tmdb is null', async () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const media = createMediaRepo(db)
    const worker = createMetadataRefreshWorker(
      { ...DEFAULT_REFRESH_CONFIG, batchSize: 5, changesFeedExtraCap: 5 },
      { media, tmdb: null, changesCursor: createChangesCursorRepo(db) },
    )
    const result = await worker.run({ useChangesFeed: false })
    expect(result.refreshed).toBe(0)
    expect(result.failed).toBe(0)
  })
})
