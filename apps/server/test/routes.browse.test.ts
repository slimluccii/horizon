import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { registerLibrary } from '../src/routes/library.ts'
import type { Config } from '../src/config.ts'
import type { MediaRepo } from '../src/repos/media.ts'
import type { CollectionsRepo } from '../src/repos/collections.ts'
import type { UserRepo } from '../src/repos/users.ts'
import type { ScanWorkers } from '../src/server.ts'

// Minimal fakes — the browse endpoint only touches the user repo (for the role
// gate) and cfg.mediaBases; the media/collections/workers args are unused here.
type Role = 'owner' | 'admin' | 'member'
function fakeUsers(byId: Record<string, Role>): UserRepo {
  return {
    get: (id: string) => (byId[id] ? { id, role: byId[id] } : undefined),
  } as unknown as UserRepo
}

const noopMedia = {} as MediaRepo
const noopCollections = {} as CollectionsRepo
const noopWorkers = {} as ScanWorkers

function buildApp(cfg: Config, users: UserRepo): FastifyInstance {
  const app = Fastify()
  registerLibrary(app, noopMedia, noopCollections, noopWorkers, users, cfg)
  return app
}

function cfgWithBases(bases: string[]): Config {
  return { mediaBases: bases } as unknown as Config
}

describe('GET /library/browse', () => {
  let base: string
  let app: FastifyInstance
  const users = fakeUsers({ owner1: 'owner', admin1: 'admin', member1: 'member' })

  beforeAll(() => {
    // realpathSync so the base matches what the endpoint returns: the browse
    // endpoint resolves every path through realpath (symlink hardening), and on
    // macOS tmpdir() is under /var which is a symlink to /private/var. Without
    // this, the test's base (/var/...) would never equal the endpoint's
    // resolved paths (/private/var/...).
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'horizon-browse-')))
    // base/
    //   movies/   (dir)
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
    app = buildApp(cfgWithBases([base]), users)
  })

  afterEach(async () => {
    await app.close()
  })

  it('400 NO_USER when the caller header is missing/unknown', async () => {
    const res = await app.inject({ method: 'GET', url: '/library/browse' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('no-user')
  })

  it('403 CALLER_FORBIDDEN for members', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/library/browse',
      headers: { 'x-horizon-user': 'member1' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
  })

  it('lists the configured bases with no path (parent null)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/library/browse',
      headers: { 'x-horizon-user': 'owner1' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.parent).toBeNull()
    expect(body.entries).toEqual([{ name: path.basename(base), path: base }])
  })

  it('lists immediate subdirectories only (never files)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/library/browse?path=${encodeURIComponent(base)}`,
      headers: { 'x-horizon-user': 'admin1' },
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
      headers: { 'x-horizon-user': 'owner1' },
    })
    expect(res.statusCode).toBe(200)
    const names = res.json().entries.map((e: { name: string }) => e.name)
    expect(names).toEqual(['action'])
  })

  it('parent is null at a base root — cannot browse above a base', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/library/browse?path=${encodeURIComponent(base)}`,
      headers: { 'x-horizon-user': 'owner1' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().parent).toBeNull()
  })

  it('parent resolves to the base when browsing a subdir', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/library/browse?path=${encodeURIComponent(path.join(base, 'movies'))}`,
      headers: { 'x-horizon-user': 'owner1' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().parent).toBe(base)
  })

  it('400 INVALID_PATH for a path outside the bases', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/library/browse?path=${encodeURIComponent('/etc')}`,
      headers: { 'x-horizon-user': 'owner1' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-path')
  })

  it('400 INVALID_PATH for a traversal escape above a base', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/library/browse?path=${encodeURIComponent(path.join(base, '..'))}`,
      headers: { 'x-horizon-user': 'owner1' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-path')
  })
})
