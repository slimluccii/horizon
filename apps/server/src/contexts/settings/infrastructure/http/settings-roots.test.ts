import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, type DatabaseSync } from '../../../../db/index.ts'
import { migrate } from '../../../../db/migrations.ts'
import { createServerSettings } from '../persistence/serverSettings.ts'
import { createUserRepo } from '../../../../repos/users.ts'
import { createSessionRepo } from '../../../../auth/session.ts'
import { makeRequireAuth } from '../../../../auth/middleware.ts'
import { registerSettings } from './settings.ts'

/** A directory with two real subdirs (Films, Series). realpathSync defeats the
 *  macOS /var → /private/var symlink so it matches the endpoint's resolution. */
function makeDirs(): { base: string; films: string; series: string } {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'horizon-media-')))
  const films = path.join(base, 'Films')
  const series = path.join(base, 'Series')
  mkdirSync(films)
  mkdirSync(series)
  return { base, films, series }
}

async function buildApp() {
  const db = openDatabase(':memory:')
  migrate(db)
  const users = createUserRepo(db)
  const serverSettings = createServerSettings(db)
  const owner = users.create({ name: 'Owner' }) // first user → owner
  const app = Fastify({ logger: false })
  // Roots are no longer base-confined; registerSettings only needs cfg to exist.
  const cfg = {} as unknown as import('../../../../config.ts').Config
  app.addHook('onRequest', makeRequireAuth(createSessionRepo(db), users))
  registerSettings(app, users, serverSettings, cfg)
  await app.ready()
  return { app, db, owner, users, serverSettings }
}

/** Session bearer header for a user id. */
const hdr = (db: DatabaseSync, id: string) => ({
  authorization: `Bearer ${createSessionRepo(db).issue(id).token}`,
})

describe('PATCH /settings/server — library roots', () => {
  it('accepts existing directories, stores resolved paths, returns them via GET', async () => {
    const { films, series } = makeDirs()
    const { app, db, owner, serverSettings } = await buildApp()

    const res = await app.inject({
      method: 'PATCH', url: '/settings/server', headers: hdr(db, owner.id),
      payload: { moviesRoots: [films], showsRoots: [series] },
    })
    expect(res.statusCode).toBe(200)
    expect(serverSettings.get().moviesRoots).toEqual([films])
    expect(serverSettings.get().showsRoots).toEqual([series])

    const get = await app.inject({ method: 'GET', url: '/settings/server', headers: hdr(db, owner.id) })
    expect(get.json().moviesRoots).toEqual([films])
    expect(get.json().showsRoots).toEqual([series])
  })

  it('accepts any existing directory — no base confinement (e.g. a temp dir)', async () => {
    const { base } = makeDirs()
    const { app, db, owner, serverSettings } = await buildApp()
    // Under the old model a path outside the configured base was rejected; now
    // any readable directory is allowed (owner/admin is trusted, Docker scopes it).
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server', headers: hdr(db, owner.id),
      payload: { moviesRoots: [base] },
    })
    expect(res.statusCode).toBe(200)
    expect(serverSettings.get().moviesRoots).toEqual([base])
  })

  it('rejects a non-existent path (400 invalid-path), no partial write', async () => {
    const { base, films } = makeDirs()
    const { app, db, owner, serverSettings } = await buildApp()
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server', headers: hdr(db, owner.id),
      payload: { moviesRoots: [films, path.join(base, 'DoesNotExist')] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-path')
    // All-or-nothing: the valid entry must NOT have been persisted.
    expect(serverSettings.get().moviesRoots).toEqual([])
  })

  it('rejects a path that is a file, not a directory', async () => {
    const { films } = makeDirs()
    const filePath = path.join(films, 'movie.mkv')
    // Create a file inside Films.
    mkdirSync(path.join(films, 'x'))
    const { app, db, owner } = await buildApp()
    void filePath
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server', headers: hdr(db, owner.id),
      payload: { showsRoots: [path.join(films, 'x', 'nope.txt')] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-path')
  })

  it('members cannot change roots (403)', async () => {
    const { films } = makeDirs()
    const { app, db, users, serverSettings } = await buildApp()
    const member = users.create({ name: 'Member' }) // second user → member
    const res = await app.inject({
      method: 'PATCH', url: '/settings/server', headers: hdr(db, member.id),
      payload: { moviesRoots: [films] },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
    expect(serverSettings.get().moviesRoots).toEqual([])
  })
})
