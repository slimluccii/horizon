import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createUserRepo, type UserRepo } from '../src/repos/users.ts'
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
  return { users, media, progress, user: u }
}

async function buildApp(users: UserRepo, media: MediaRepo, progress: ProgressRepo) {
  const app = Fastify({ logger: false })
  registerProgress(app, users, progress)
  await app.ready()
  return app
}

describe('progress routes', () => {
  it('GET /users/:userId/progress/:mediaId 404 when no entry', async () => {
    const { users, media, progress, user } = setup()
    const app = await buildApp(users, media, progress)
    const res = await app.inject({
      method: 'GET', url: `/users/${user.id}/progress/m1`,
      headers: { 'x-horizon-user': user.id },
    })
    expect(res.statusCode).toBe(404)
  })

  it('rejects with 400 when X-Horizon-User is missing', async () => {
    const { users, media, progress, user } = setup()
    const app = await buildApp(users, media, progress)
    const res = await app.inject({
      method: 'GET', url: `/users/${user.id}/progress/m1`,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('no-user')
  })

  it('rejects when header user differs from path', async () => {
    const { users, media, progress, user } = setup()
    const app = await buildApp(users, media, progress)
    const res = await app.inject({
      method: 'GET', url: `/users/${user.id}/progress/m1`,
      headers: { 'x-horizon-user': 'someone-else' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('PATCH watched flag', async () => {
    const { users, media, progress, user } = setup()
    progress.setProgress(user.id, 'm1', { positionMs: 1000, durationMs: 60_000 })
    const app = await buildApp(users, media, progress)
    const res = await app.inject({
      method: 'PATCH', url: `/users/${user.id}/progress/m1`,
      headers: { 'x-horizon-user': user.id },
      payload: { watched: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().watched).toBe(true)
  })

  it('GET continue-watching returns list', async () => {
    const { users, media, progress, user } = setup()
    progress.setProgress(user.id, 'm1', { positionMs: 1000, durationMs: 60_000 })
    const app = await buildApp(users, media, progress)
    const res = await app.inject({
      method: 'GET', url: `/users/${user.id}/continue-watching`,
      headers: { 'x-horizon-user': user.id },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(1)
  })
})
