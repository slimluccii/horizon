import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createUserRepo } from '../src/repos/users.ts'
import { createMediaRepo } from '../src/repos/media.ts'
import { createCollectionsRepo } from '../src/repos/collections.ts'
import { registerLibrary } from '../src/routes/library.ts'
import type { ScanWorkers } from '../src/server.ts'
import type { Config } from '../src/config.ts'

/**
 * Authorization tests for the /library/* routes (issues #32, #39, #45, #46).
 *
 * Contract enforced:
 *   • GET routes require an authenticated user (any role) → 400 no-user otherwise
 *   • POST routes (rescan, metadata-refresh) require owner|admin → member gets
 *     403 caller-forbidden; unauthenticated gets 400 no-user
 *
 * This mirrors the role gate already in PATCH /settings/server, reusing the
 * shared resolveCallerRole helper from routes/authz.ts.
 */

function setup() {
  const db = openDatabase(':memory:')
  migrate(db)
  const users = createUserRepo(db)
  const media = createMediaRepo(db)
  const collections = createCollectionsRepo(db)
  const owner = users.create({ name: 'Alice' })          // auto-elected owner
  const admin = users.update(users.create({ name: 'Bob' }).id, { role: 'admin' })!
  const member = users.create({ name: 'Carol' })          // default member
  return { db, users, media, collections, owner, admin, member }
}

/** Minimal ScanWorkers stub — the routes only call the methods exercised here. */
function makeWorkers(opts: { tmdbConfigured: boolean }): ScanWorkers {
  const scanRequests: unknown[] = []
  const refreshRuns: unknown[] = []
  return {
    scanManager: {
      request: async (req: unknown) => { scanRequests.push(req); return 'queued' as const },
      status: () => ({ running: false, pending: null, lastResult: null }),
    },
    refreshWorker: {
      run: async (o: unknown) => { refreshRuns.push(o); return { refreshed: 0, failed: 0, changesFeedHits: 0, durationMs: 0 } },
      status: () => ({ running: false, lastResult: null, configured: opts.tmdbConfigured, errorState: null }),
      setTmdb: () => undefined,
    },
    scanHistory: {
      recent: () => [],
    },
  } as unknown as ScanWorkers
}

async function buildApp(
  s: ReturnType<typeof setup>,
  workers: ScanWorkers = makeWorkers({ tmdbConfigured: true }),
) {
  const app = Fastify({ logger: false })
  const cfg = { mediaBases: [] } as unknown as Config
  registerLibrary(app, s.media, s.collections, workers, s.users, cfg)
  await app.ready()
  return app
}

describe('GET /library/* — authentication', () => {
  it('GET /library/movies without X-Horizon-User → 400 no-user', async () => {
    const s = setup()
    const app = await buildApp(s)
    const res = await app.inject({ method: 'GET', url: '/library/movies' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('no-user')
  })

  it('GET /library/movies with a member user → 200', async () => {
    const s = setup()
    const app = await buildApp(s)
    const res = await app.inject({
      method: 'GET', url: '/library/movies',
      headers: { 'x-horizon-user': s.member.id },
    })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
  })

  it('GET /library/movies with an unknown user → 400 no-user', async () => {
    const s = setup()
    const app = await buildApp(s)
    const res = await app.inject({
      method: 'GET', url: '/library/movies',
      headers: { 'x-horizon-user': 'ghost' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('no-user')
  })

  it('GET /library/shows without header → 400; with member → 200', async () => {
    const s = setup()
    const app = await buildApp(s)
    const anon = await app.inject({ method: 'GET', url: '/library/shows' })
    expect(anon.statusCode).toBe(400)
    const ok = await app.inject({
      method: 'GET', url: '/library/shows',
      headers: { 'x-horizon-user': s.member.id },
    })
    expect(ok.statusCode).toBe(200)
    expect(Array.isArray(ok.json())).toBe(true)
  })

  it('GET /library/movies/collections without header → 400; with member → 200', async () => {
    const s = setup()
    const app = await buildApp(s)
    const anon = await app.inject({ method: 'GET', url: '/library/movies/collections' })
    expect(anon.statusCode).toBe(400)
    const ok = await app.inject({
      method: 'GET', url: '/library/movies/collections',
      headers: { 'x-horizon-user': s.member.id },
    })
    expect(ok.statusCode).toBe(200)
    expect(Array.isArray(ok.json())).toBe(true)
  })

  it('GET /library/scan-status without header → 400; with member → 200', async () => {
    const s = setup()
    const app = await buildApp(s)
    const anon = await app.inject({ method: 'GET', url: '/library/scan-status' })
    expect(anon.statusCode).toBe(400)
    const ok = await app.inject({
      method: 'GET', url: '/library/scan-status',
      headers: { 'x-horizon-user': s.member.id },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toHaveProperty('scan')
    expect(ok.json()).toHaveProperty('metadata')
  })
})

describe('POST /library/rescan — authorization', () => {
  it('without header → 400 no-user', async () => {
    const s = setup()
    const app = await buildApp(s)
    const res = await app.inject({ method: 'POST', url: '/library/rescan', payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('no-user')
  })

  it('with an unknown user → 400 no-user', async () => {
    const s = setup()
    const app = await buildApp(s)
    const res = await app.inject({
      method: 'POST', url: '/library/rescan', payload: {},
      headers: { 'x-horizon-user': 'ghost' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('no-user')
  })

  it('with a member user → 403 caller-forbidden', async () => {
    const s = setup()
    const app = await buildApp(s)
    const res = await app.inject({
      method: 'POST', url: '/library/rescan', payload: {},
      headers: { 'x-horizon-user': s.member.id },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
  })

  it('with an owner user → 202 queued', async () => {
    const s = setup()
    const app = await buildApp(s)
    const res = await app.inject({
      method: 'POST', url: '/library/rescan', payload: {},
      headers: { 'x-horizon-user': s.owner.id },
    })
    expect(res.statusCode).toBe(202)
    expect(res.json().status).toBe('queued')
  })

  it('with an admin user → 202 queued', async () => {
    const s = setup()
    const app = await buildApp(s)
    const res = await app.inject({
      method: 'POST', url: '/library/rescan', payload: {},
      headers: { 'x-horizon-user': s.admin.id },
    })
    expect(res.statusCode).toBe(202)
  })
})

describe('POST /library/metadata-refresh — authorization', () => {
  it('without header → 400 no-user', async () => {
    const s = setup()
    const app = await buildApp(s)
    const res = await app.inject({ method: 'POST', url: '/library/metadata-refresh' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('no-user')
  })

  it('with a member user → 403 caller-forbidden (before the TMDB-config check)', async () => {
    const s = setup()
    // TMDB not configured — authz must fail first regardless of config state.
    const app = await buildApp(s, makeWorkers({ tmdbConfigured: false }))
    const res = await app.inject({
      method: 'POST', url: '/library/metadata-refresh',
      headers: { 'x-horizon-user': s.member.id },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
  })

  it('with an owner user and TMDB configured → 202 queued', async () => {
    const s = setup()
    const app = await buildApp(s, makeWorkers({ tmdbConfigured: true }))
    const res = await app.inject({
      method: 'POST', url: '/library/metadata-refresh',
      headers: { 'x-horizon-user': s.owner.id },
    })
    expect(res.statusCode).toBe(202)
    expect(res.json().status).toBe('queued')
  })

  it('with an admin user and TMDB configured → 202 queued', async () => {
    const s = setup()
    const app = await buildApp(s, makeWorkers({ tmdbConfigured: true }))
    const res = await app.inject({
      method: 'POST', url: '/library/metadata-refresh',
      headers: { 'x-horizon-user': s.admin.id },
    })
    expect(res.statusCode).toBe(202)
  })
})
