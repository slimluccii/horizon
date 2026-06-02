import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { openDatabase, type DatabaseSync } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createUserRepo, type UserRepo } from '../src/repos/users.ts'
import { createSessionRepo } from '../src/auth/session.ts'
import { makeRequireAuth } from '../src/auth/middleware.ts'
import { createMediaRepo, type MediaRepo } from '../src/repos/media.ts'
import { createProgressRepo, type ProgressRepo } from '../src/repos/progress.ts'
import { registerProgress } from '../src/routes/progress.ts'

function movie(id: string) {
  return {
    id, filePath: `/${id}.mkv`, title: id, sortYear: 2020,
    durationSec: 100, resolution: '1920x1080', videoCodec: 'h264', container: 'matroska',
    hdr: { dv: false, hdr10: false, hdr10plus: false },
    audioTracks: [], subtitleTracks: [], mtimeMs: 1, sizeBytes: 1,
    externalIds: {}, metadata: null,
  }
}

function setup() {
  const db = openDatabase(':memory:'); migrate(db)
  const users = createUserRepo(db)
  const media = createMediaRepo(db)
  const progress = createProgressRepo(db, media, { getWatchedThresholdPct: () => 90 })
  const u = users.create({ name: 'Luuk' })
  media.upsertMovie(movie('m1'))
  return { db, users, media, progress, user: u }
}

async function buildApp(db: DatabaseSync, users: UserRepo, media: MediaRepo, progress: ProgressRepo) {
  const app = Fastify({ logger: false })
  app.addHook('onRequest', makeRequireAuth(createSessionRepo(db), users))
  registerProgress(app, users, progress)
  await app.ready()
  return app
}

/** Session bearer header for a user id. */
function hdr(db: DatabaseSync, userId: string): { authorization: string } {
  return { authorization: `Bearer ${createSessionRepo(db).issue(userId).token}` }
}

describe('progress routes', () => {
  it('GET /users/:userId/progress/:mediaId 404 when no entry', async () => {
    const { db, users, media, progress, user } = setup()
    const app = await buildApp(db, users, media, progress)
    const res = await app.inject({
      method: 'GET', url: `/users/${user.id}/progress/m1`,
      headers: hdr(db, user.id),
    })
    expect(res.statusCode).toBe(404)
  })

  it('rejects with 401 when unauthenticated', async () => {
    const { db, users, media, progress, user } = setup()
    const app = await buildApp(db, users, media, progress)
    const res = await app.inject({
      method: 'GET', url: `/users/${user.id}/progress/m1`,
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthorized')
  })

  it('rejects when session user differs from path user', async () => {
    const { db, users, media, progress, user } = setup()
    const other = users.create({ name: 'Other' })
    const app = await buildApp(db, users, media, progress)
    const res = await app.inject({
      method: 'GET', url: `/users/${user.id}/progress/m1`,
      headers: hdr(db, other.id),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('user-mismatch')
  })

  it('PATCH watched flag', async () => {
    const { db, users, media, progress, user } = setup()
    progress.setProgress(user.id, 'm1', { positionMs: 1000, durationMs: 60_000 })
    const app = await buildApp(db, users, media, progress)
    const res = await app.inject({
      method: 'PATCH', url: `/users/${user.id}/progress/m1`,
      headers: hdr(db, user.id),
      payload: { watched: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().watched).toBe(true)
  })

  it('GET continue-watching returns list', async () => {
    const { db, users, media, progress, user } = setup()
    progress.setProgress(user.id, 'm1', { positionMs: 1000, durationMs: 60_000 })
    const app = await buildApp(db, users, media, progress)
    const res = await app.inject({
      method: 'GET', url: `/users/${user.id}/continue-watching`,
      headers: hdr(db, user.id),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(1)
  })
})
