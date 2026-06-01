import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createServerSettings } from '../src/repos/serverSettings.ts'
import { createUserRepo } from '../src/repos/users.ts'
import { registerSettings } from '../src/routes/settings.ts'

/** A media base with two real subdirs (Films, Series). realpathSync defeats the
 *  macOS /var → /private/var symlink so it matches the endpoint's resolution. */
function makeBase(): { base: string; films: string; series: string } {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'horizon-media-')))
  const films = path.join(base, 'Films')
  const series = path.join(base, 'Series')
  mkdirSync(films)
  mkdirSync(series)
  return { base, films, series }
}

async function buildApp(mediaBases: string[]) {
  const db = openDatabase(':memory:')
  migrate(db)
  const users = createUserRepo(db)
  const serverSettings = createServerSettings(db)
  const owner = users.create({ name: 'Owner' }) // first user → owner
  const app = Fastify({ logger: false })
  const cfg = { mediaBases } as unknown as import('../src/config.ts').Config
  registerSettings(app, users, serverSettings, cfg)
  await app.ready()
  return { app, owner, users, serverSettings }
}

const hdr = (id: string) => ({ 'x-horizon-user': id })

describe('PATCH /settings/server — library roots confinement', () => {
  it('accepts roots under a base, stores resolved paths, returns them via GET', async () => {
    const { base, films, series } = makeBase()
    const { app, owner, serverSettings } = await buildApp([base])

    const res = await app.inject({
      method: 'PATCH', url: '/settings/server', headers: hdr(owner.id),
      payload: { moviesRoots: [films], showsRoots: [series] },
    })
    expect(res.statusCode).toBe(200)
    expect(serverSettings.get().moviesRoots).toEqual([films])
    expect(serverSettings.get().showsRoots).toEqual([series])

    const get = await app.inject({ method: 'GET', url: '/settings/server', headers: hdr(owner.id) })
    expect(get.json().moviesRoots).toEqual([films])
    expect(get.json().showsRoots).toEqual([series])
  })

  it('rejects a root outside every base (400 invalid-path), no partial write', async () => {
    const { base, films } = makeBase()
    const { app, owner, serverSettings } = await buildApp([base])

    const res = await app.inject({
      method: 'PATCH', url: '/settings/server', headers: hdr(owner.id),
      payload: { moviesRoots: [films, '/etc'] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-path')
    // The valid entry must NOT have been persisted — all-or-nothing.
    expect(serverSettings.get().moviesRoots).toEqual([])
  })

  it('rejects a non-existent path under the base', async () => {
    const { base } = makeBase()
    const { app, owner } = await buildApp([base])
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server', headers: hdr(owner.id),
      payload: { showsRoots: [path.join(base, 'DoesNotExist')] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-path')
  })

  it('members cannot change roots (403)', async () => {
    const { base, films } = makeBase()
    const { app, users, serverSettings } = await buildApp([base])
    const member = users.create({ name: 'Member' }) // second user → member
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server', headers: hdr(member.id),
      payload: { moviesRoots: [films] },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
    expect(serverSettings.get().moviesRoots).toEqual([])
  })
})
