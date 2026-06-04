import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { registerLibrary } from './library.ts'
import { makeRequireAuth } from '../../../identity/index.ts'
import type { Config } from '../../../../config.ts'
import type { MediaRepo } from '../persistence/media.ts'
import type { CollectionsRepo } from '../persistence/collections.ts'
import type { UserRepo } from '../../../identity/index.ts'
import type { SessionRepo } from '../../../identity/index.ts'
import type { ScanWorkers } from '../../../../server.ts'

// Minimal fakes — the browse endpoint only touches the user repo (for the role
// gate); the media/collections/workers/cfg args are unused by it now (the
// filesystem browser has no base confinement).
type Role = 'owner' | 'admin' | 'member'
function fakeUsers(byId: Record<string, Role>): UserRepo {
  return {
    get: (id: string) => (byId[id] ? { id, role: byId[id] } : undefined),
  } as unknown as UserRepo
}

// Fake session repo for the auth hook: the bearer token IS the user id, so a
// request authenticates as whatever id it presents (kept simple — the browse
// authz logic, not session minting, is what's under test here).
function fakeSessions(byId: Record<string, Role>): SessionRepo {
  return {
    resolve: (token: string) => (byId[token]
      ? { id: `sess-${token}`, userId: token, createdAt: 0, expiresAt: Date.now() + 1e6, lastSeenAt: 0, userAgent: null }
      : null),
  } as unknown as SessionRepo
}

/** Bearer header that authenticates as a given user id. */
const tok = (id: string) => ({ authorization: `Bearer ${id}` })

const noopMedia = {} as MediaRepo
const noopCollections = {} as CollectionsRepo
const noopWorkers = {} as ScanWorkers
const noopCfg = {} as Config

function buildApp(users: UserRepo, sessions: SessionRepo): FastifyInstance {
  const app = Fastify()
  app.addHook('onRequest', makeRequireAuth(sessions, users))
  registerLibrary(app, noopMedia, noopCollections, noopWorkers, users, noopCfg)
  return app
}

describe('GET /library/browse', () => {
  let base: string
  let app: FastifyInstance
  const roles: Record<string, Role> = { owner1: 'owner', admin1: 'admin', member1: 'member' }
  const users = fakeUsers(roles)
  const sessions = fakeSessions(roles)

  beforeAll(() => {
    // realpathSync so the test dir matches what the endpoint returns: the browse
    // endpoint canonicalises every path, and on macOS tmpdir() is under /var
    // which is a symlink to /private/var.
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'horizon-browse-')))
    // base/
    //   movies/   (dir) → action/ (dir), readme.txt (file)
    //   shows/    (dir)
    //   notes.txt (file — must never appear)
    mkdirSync(path.join(base, 'movies'))
    mkdirSync(path.join(base, 'shows'))
    mkdirSync(path.join(base, 'movies', 'action'))
    writeFileSync(path.join(base, 'notes.txt'), 'x')
    writeFileSync(path.join(base, 'movies', 'readme.txt'), 'x')
  })

  afterAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  beforeEach(() => {
    app = buildApp(users, sessions)
  })

  afterEach(async () => {
    await app.close()
  })

  it('401 unauthorized when unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/library/browse' })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthorized')
  })

  it('403 CALLER_FORBIDDEN for members', async () => {
    const res = await app.inject({ method: 'GET', url: '/library/browse', headers: tok('member1') })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
  })

  it('defaults to the filesystem root with no path (parent null)', async () => {
    const res = await app.inject({ method: 'GET', url: '/library/browse', headers: tok('owner1') })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // Root of the filesystem: no parent, and it lists real top-level dirs.
    expect(body.parent).toBeNull()
    expect(Array.isArray(body.entries)).toBe(true)
    expect(body.entries.length).toBeGreaterThan(0)
  })

  it('lists immediate subdirectories only (never files)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/library/browse?path=${encodeURIComponent(base)}`,
      headers: tok('admin1'),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    const names = body.entries.map((e: { name: string }) => e.name)
    expect(names).toEqual(['movies', 'shows'])
    expect(names).not.toContain('notes.txt')
    expect(body.entries).toContainEqual({ name: 'movies', path: path.join(base, 'movies') })
  })

  it('excludes files at a deeper level too', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/library/browse?path=${encodeURIComponent(path.join(base, 'movies'))}`,
      headers: tok('owner1'),
    })
    expect(res.statusCode).toBe(200)
    const names = res.json().entries.map((e: { name: string }) => e.name)
    expect(names).toEqual(['action'])
  })

  it('parent resolves to the containing directory when browsing a subdir', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/library/browse?path=${encodeURIComponent(path.join(base, 'movies'))}`,
      headers: tok('owner1'),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().parent).toBe(base)
  })

  it('can browse anywhere readable — no base confinement (e.g. the temp root)', async () => {
    // The parent of our base is browsable now; under the old model this 400'd.
    const parent = path.dirname(base)
    const res = await app.inject({
      method: 'GET',
      url: `/library/browse?path=${encodeURIComponent(parent)}`,
      headers: tok('owner1'),
    })
    expect(res.statusCode).toBe(200)
    const names = res.json().entries.map((e: { name: string }) => e.name)
    expect(names).toContain(path.basename(base))
  })

  it('normalises traversal segments (..) into a canonical path', async () => {
    // base/movies/.. → base ; resolves cleanly rather than being rejected.
    const res = await app.inject({
      method: 'GET',
      url: `/library/browse?path=${encodeURIComponent(path.join(base, 'movies', '..'))}`,
      headers: tok('owner1'),
    })
    expect(res.statusCode).toBe(200)
    const names = res.json().entries.map((e: { name: string }) => e.name)
    expect(names).toEqual(['movies', 'shows'])
  })

  it('400 INVALID_PATH for a non-existent / unreadable directory', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/library/browse?path=${encodeURIComponent(path.join(base, 'does-not-exist'))}`,
      headers: tok('owner1'),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-path')
  })
})
