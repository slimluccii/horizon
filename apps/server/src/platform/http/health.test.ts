import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { registerHealth } from './health.ts'
import { buildServer } from './server.ts'
import { openDatabase } from '../db/connection.ts'
import { migrate } from '../db/migrations.ts'
import { createMediaRepo, createCollectionsRepo, createScanHistoryRepo } from '../../contexts/library/index.ts'
import { createUserRepo, createSessionRepo, createHouseholdRepo } from '../../contexts/identity/index.ts'
import { createProgressRepo } from '../../contexts/playback/index.ts'
import { createServerSettings } from '../../contexts/settings/index.ts'
import { createActivityBus } from '../../contexts/activity/index.ts'
import type { Config } from '../config/config.ts'
import type { Identity } from '../identity/identity.ts'

const fakeHw = { ffmpegVersion: '6.0', encoder: 'vaapi' } as any
const identity: Identity = { instanceId: 'id-123', serverName: 'Den', version: '0.1.0' }

describe('GET /health', () => {
  it('returns status + identity fields', async () => {
    const app = Fastify()
    registerHealth(app, fakeHw, identity)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      status: 'ok',
      serverName: 'Den',
      instanceId: 'id-123',
    })
    await app.close()
  })
})

// Integration: assert identity flows through buildServer into /health in the
// correct argument position. The unit test above injects identity directly, so
// it stays green even if the buildServer call site shifts identity into the
// wrong slot — this test exercises the wiring that regressed (identity arg vs
// the optional db arg) by booting the real server.
describe('buildServer wiring → /health', () => {
  function makeApp(cfgOverrides: Partial<Config> = {}) {
    const db = openDatabase(':memory:')
    migrate(db)
    const mediaRepo = createMediaRepo(db)
    const collectionsRepo = createCollectionsRepo(db)
    const userRepo = createUserRepo(db)
    const sessionRepo = createSessionRepo(db)
    const householdRepo = createHouseholdRepo(db)
    const serverSettings = createServerSettings(db)
    const progressRepo = createProgressRepo(db, mediaRepo, {
      getWatchedThresholdPct: () => serverSettings.get().watchedThresholdPct,
    })
    const scanHistory = createScanHistoryRepo(db)

    const cfg = {
      corsOrigins: [],
      devSeedEnabled: false,
      serveWeb: false,
      webDir: undefined,
      ...cfgOverrides,
    } as unknown as Config

    // The session/scan managers are only stored by buildServer, never invoked
    // by GET /health or GET /api/dev/seed — stub them to keep the test light.
    return buildServer(
      cfg,
      fakeHw,
      { mediaRepo, collectionsRepo, userRepo, sessionRepo, householdRepo, progressRepo, serverSettings },
      {} as any,
      { scanManager: {} as any, refreshWorker: {} as any, scanHistory, activityBus: createActivityBus() },
      {} as any,
      identity,
      db,
    )
  }

  it('exposes the injected identity on /api/health (real boot, no auth)', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      status: 'ok',
      serverName: 'Den',
      instanceId: 'id-123',
      version: '0.1.0',
    })
    await app.close()
  })

  it('keeps the dev-seed guard working when db is passed (db reached the db arg, not identity)', async () => {
    const app = await makeApp({ devSeedEnabled: true })
    // GET /api/dev/seed only registers when `cfg.devSeedEnabled && db` is truthy.
    // If db had landed in the identity slot, this guard would be permanently
    // false and the route would 404.
    const res = await app.inject({ method: 'GET', url: '/api/dev/seed' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('scenarios')
    await app.close()
  })
})
