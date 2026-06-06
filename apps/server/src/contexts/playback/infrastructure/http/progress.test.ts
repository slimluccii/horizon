import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { openDatabase, type DatabaseSync } from '../../../../platform/db/connection.ts'
import { migrate } from '../../../../platform/db/migrations.ts'
import { createUserRepo, type UserRepo } from '../../../identity/index.ts'
import { createSessionRepo } from '../../../identity/index.ts'
import { makeRequireAuth, makeResolveProfile } from '../../../identity/index.ts'
import { createMediaRepo, type MediaRepo } from '../../../library/index.ts'
import { createProgressRepo, type ProgressRepo } from '../persistence/progress.ts'
import { registerProgress } from './progress.ts'

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
  // resolveProfile runs after requireAuth and sets req.profileUserId — the
  // acting user the per-user handlers key off (Task 14).
  app.addHook('preHandler', makeResolveProfile(createSessionRepo(db), users))
  registerProgress(app, users, progress)
  await app.ready()
  return app
}

/** Session bearer header for a user id, optionally with an act-as grant. */
function hdr(db: DatabaseSync, userId: string, grant?: string[]): { authorization: string } {
  return { authorization: `Bearer ${createSessionRepo(db).issue(userId, null, grant).token}` }
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

  it('rejects when active profile differs from path user', async () => {
    const { db, users, media, progress, user } = setup()
    const other = users.create({ name: 'Other' })
    const app = await buildApp(db, users, media, progress)
    const res = await app.inject({
      method: 'GET', url: `/users/${user.id}/progress/m1`,
      headers: hdr(db, other.id),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('user-mismatch')
  })

  it('continue-watching keys off the active profile, not the path :userId', async () => {
    // Session principal is `user`, granted to also act as `partner`. With
    // X-Horizon-Profile: partner the handler must read PARTNER's data — keyed
    // off req.profileUserId, never the path or the session principal.
    const { db, users, media, progress, user } = setup()
    const partner = users.create({ name: 'Partner' })
    progress.setProgress(partner.id, 'm1', { positionMs: 1000, durationMs: 60_000 })
    const app = await buildApp(db, users, media, progress)
    const res = await app.inject({
      method: 'GET', url: `/users/${partner.id}/continue-watching`,
      headers: {
        ...hdr(db, user.id, [user.id, partner.id]),
        'x-horizon-profile': partner.id,
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().length).toBeGreaterThan(0)
  })

  it('rejects when the active profile disagrees with the path :userId (403)', async () => {
    // Principal `user`, granted to act as `partner`, active profile = partner,
    // but the path names `user`. The path must equal the active profile.
    const { db, users, media, progress, user } = setup()
    const partner = users.create({ name: 'Partner' })
    const app = await buildApp(db, users, media, progress)
    const res = await app.inject({
      method: 'GET', url: `/users/${user.id}/continue-watching`,
      headers: {
        ...hdr(db, user.id, [user.id, partner.id]),
        'x-horizon-profile': partner.id,
      },
    })
    expect(res.statusCode).toBe(403)
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
