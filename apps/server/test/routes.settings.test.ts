import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createUserRepo } from '../src/repos/users.ts'
import { createServerSettings } from '../src/repos/serverSettings.ts'
import { createSessionManager } from '../src/session/manager.ts'
import { registerSettings } from '../src/routes/settings.ts'
import type { ServerSettings } from '../src/repos/serverSettings.ts'

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
  return { users, serverSettings, owner, admin, member }
}

async function buildApp(users: ReturnType<typeof setup>['users'], serverSettings: ServerSettings) {
  const app = Fastify({ logger: false })
  registerSettings(app, users, serverSettings)
  await app.ready()
  return app
}

describe('GET /settings/server', () => {
  it('returns the live row to any authenticated user', async () => {
    const { users, serverSettings, member } = setup()
    const app = await buildApp(users, serverSettings)
    const res = await app.inject({
      method: 'GET', url: '/settings/server',
      headers: { 'x-horizon-user': member.id },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('watchedThresholdPct')
    expect(body).toHaveProperty('scanCronHour')
    expect(body).toHaveProperty('watchFs')
    expect(body).toHaveProperty('watchDebounceMs')
  })

  it('masks tmdbToken as "unset" when not set', async () => {
    const { users, serverSettings, member } = setup()
    const app = await buildApp(users, serverSettings)
    const res = await app.inject({
      method: 'GET', url: '/settings/server',
      headers: { 'x-horizon-user': member.id },
    })
    expect(res.json().tmdbToken).toBe('unset')
  })

  it('masks tmdbToken as "set" when a token is present', async () => {
    const { users, serverSettings, owner } = setup()
    serverSettings.update({ tmdbToken: 'abc-secret' })
    const app = await buildApp(users, serverSettings)
    const res = await app.inject({
      method: 'GET', url: '/settings/server',
      headers: { 'x-horizon-user': owner.id },
    })
    expect(res.json().tmdbToken).toBe('set')
  })

  it('rejects with 400 when X-Horizon-User header is missing', async () => {
    const { users, serverSettings } = setup()
    const app = await buildApp(users, serverSettings)
    const res = await app.inject({ method: 'GET', url: '/settings/server' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('no-user')
  })

  it('does not leak seededFromEnv', async () => {
    const { users, serverSettings, member } = setup()
    const app = await buildApp(users, serverSettings)
    const res = await app.inject({
      method: 'GET', url: '/settings/server',
      headers: { 'x-horizon-user': member.id },
    })
    expect(res.json()).not.toHaveProperty('seededFromEnv')
  })
})

describe('PATCH /settings/server — role gate', () => {
  it('owner can PATCH', async () => {
    const { users, serverSettings, owner } = setup()
    const app = await buildApp(users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: { 'x-horizon-user': owner.id },
      payload: { watchedThresholdPct: 85 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().watchedThresholdPct).toBe(85)
  })

  it('admin can PATCH', async () => {
    const { users, serverSettings, admin } = setup()
    const app = await buildApp(users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: { 'x-horizon-user': admin.id },
      payload: { scanCronHour: 4 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().scanCronHour).toBe(4)
  })

  it('member is rejected with 403', async () => {
    const { users, serverSettings, member } = setup()
    const app = await buildApp(users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: { 'x-horizon-user': member.id },
      payload: { watchedThresholdPct: 50 },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
  })

  it('missing header is rejected with 400', async () => {
    const { users, serverSettings } = setup()
    const app = await buildApp(users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      payload: { watchedThresholdPct: 50 },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('no-user')
  })
})

describe('PATCH /settings/server — validation', () => {
  it('rejects unknown keys (strict schema)', async () => {
    const { users, serverSettings, owner } = setup()
    const app = await buildApp(users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: { 'x-horizon-user': owner.id },
      payload: { unknownField: 'oops' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('rejects scanCronHour out of range', async () => {
    const { users, serverSettings, owner } = setup()
    const app = await buildApp(users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: { 'x-horizon-user': owner.id },
      payload: { scanCronHour: 25 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects watchedThresholdPct out of range', async () => {
    const { users, serverSettings, owner } = setup()
    const app = await buildApp(users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: { 'x-horizon-user': owner.id },
      payload: { watchedThresholdPct: 0 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('accepts empty patch (no-op)', async () => {
    const { users, serverSettings, owner } = setup()
    const app = await buildApp(users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: { 'x-horizon-user': owner.id },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
  })

  it('rejects maxSessions <= 0', async () => {
    const { users, serverSettings, owner } = setup()
    const app = await buildApp(users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: { 'x-horizon-user': owner.id },
      payload: { maxSessions: 0 },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('rejects maxRenditions <= 0', async () => {
    const { users, serverSettings, owner } = setup()
    const app = await buildApp(users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: { 'x-horizon-user': owner.id },
      payload: { maxRenditions: 0 },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('rejects maxSessions above hard cap', async () => {
    const { users, serverSettings, owner } = setup()
    const app = await buildApp(users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: { 'x-horizon-user': owner.id },
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
      moviesRoots: [],
      showsRoots: [],
      corsOrigins: ['*'],
      cacheDir: '/tmp',
      dbPath: ':memory:',
      devSeedEnabled: false,
      toneMap: { operator: 'hable', param: undefined, desat: undefined, peak: undefined, postCorrection: true },
    } as import('../src/config.ts').Config)

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
      moviesRoots: [],
      showsRoots: [],
      corsOrigins: ['*'],
      cacheDir: '/tmp',
      dbPath: ':memory:',
      devSeedEnabled: false,
      toneMap: { operator: 'hable', param: undefined, desat: undefined, peak: undefined, postCorrection: true },
    } as import('../src/config.ts').Config

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
    const { users, serverSettings, owner } = setup()
    const app = await buildApp(users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: { 'x-horizon-user': owner.id },
      payload: { maxSessions: 8 },
    })
    expect(res.statusCode).toBe(200)
    expect(serverSettings.get().maxSessions).toBe(8)
  })

  it('persists tonemapOperator and get() reflects new value', async () => {
    const { users, serverSettings, owner } = setup()
    const app = await buildApp(users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: { 'x-horizon-user': owner.id },
      payload: { tonemapOperator: 'mobius' },
    })
    expect(res.statusCode).toBe(200)
    expect(serverSettings.get().tonemapOperator).toBe('mobius')
  })

  it('persists tonemapParam and tonemapDesat', async () => {
    const { users, serverSettings, owner } = setup()
    const app = await buildApp(users, serverSettings)
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server',
      headers: { 'x-horizon-user': owner.id },
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
    })).not.toThrow()
  })
})
