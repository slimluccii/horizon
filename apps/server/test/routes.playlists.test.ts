import { describe, it, expect, afterEach } from 'vitest'
import Fastify from 'fastify'
import { openDatabase, type DatabaseSync } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createServerSettings } from '../src/repos/serverSettings.ts'
import { createUserRepo } from '../src/repos/users.ts'
import { createSessionRepo } from '../src/auth/session.ts'
import { makeRequireAuth } from '../src/auth/middleware.ts'
import { createSessionManager } from '../src/session/manager.ts'
import { registerPlaylists } from '../src/routes/playlists.ts'
import type { PlaybackPlan } from '../src/transcode/plan.ts'

function plan(renditionCount: number): PlaybackPlan {
  return {
    method: renditionCount === 0 ? 'direct-play' : 'transcode',
    renditions: Array.from({ length: renditionCount }, (_, i) => ({
      profile: { name: `r${i}` },
    })),
  } as unknown as PlaybackPlan
}

function makeSession(renditionCount: number, opts: { ownedByMember?: boolean; userId?: string | null } = {}) {
  const db = openDatabase(':memory:')
  migrate(db)
  const serverSettings = createServerSettings(db)
  const users = createUserRepo(db)
  const owner = users.create({ name: 'Alice' }) // auto-elected owner
  const admin = users.update(users.create({ name: 'Bob' }).id, { role: 'admin' })!
  const member = users.create({ name: 'Carol' }) // default member
  const other = users.create({ name: 'Dave' }) // another member
  const sessions = createSessionManager(serverSettings)
  // Default to headless (no owner) so existing token/bounds tests are
  // unaffected; ownership tests set ownedByMember or an explicit userId.
  const userId = opts.ownedByMember ? member.id : (opts.userId === undefined ? null : opts.userId)
  const session = sessions.create({
    mediaId: 'm1',
    filePath: '/tmp/x.mkv',
    plan: plan(renditionCount),
    selectedSubtitleTrack: null,
    audioTrackCount: 1,
    subtitleTrackCount: 0,
    renditionCodecs: [],
    sessionDir: '/tmp/sess',
    sessionReady: true,
    durationSec: 100,
    userId: userId ?? undefined,
  } as unknown as Parameters<typeof sessions.create>[0])
  return { db, sessions, users, session, owner, admin, member, other }
}

async function buildApp(
  db: DatabaseSync,
  sessions: ReturnType<typeof createSessionManager>,
  users: ReturnType<typeof createUserRepo>,
) {
  const app = Fastify({ logger: false })
  app.addHook('onRequest', makeRequireAuth(createSessionRepo(db), users))
  registerPlaylists(app, sessions, users)
  await app.ready()
  return app
}

let app: Awaited<ReturnType<typeof buildApp>> | undefined
afterEach(async () => { if (app) { await app.close(); app = undefined } })

/** Session bearer header for a user id (authenticates the request). */
function bearer(db: DatabaseSync, userId: string): { authorization: string } {
  return { authorization: `Bearer ${createSessionRepo(db).issue(userId).token}` }
}

/** Reconnect-token header plus an authenticated owner session bearer. The
 *  token/bounds tests run against a headless session and authenticate as owner. */
const tokenHeader = (db: DatabaseSync, ownerId: string, token: string) => ({
  'x-reconnect-token': token,
  ...bearer(db, ownerId),
})

describe('GET /sessions/:id/renditions/:r.m3u8 rendition bounds', () => {
  it('rejects r >= plan.renditions.length with 400 invalid-input', async () => {
    const { db, owner, sessions, users, session } = makeSession(2)
    app = await buildApp(db, sessions, users)
    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/renditions/2.m3u8`,
      headers: tokenHeader(db, owner.id, session.reconnectToken),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('rejects all renditions for a direct-play session (0 renditions)', async () => {
    const { db, owner, sessions, users, session } = makeSession(0)
    app = await buildApp(db, sessions, users)
    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/renditions/0.m3u8`,
      headers: tokenHeader(db, owner.id, session.reconnectToken),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('accepts a valid r and returns an .m3u8 playlist', async () => {
    const { db, owner, sessions, users, session } = makeSession(2)
    app = await buildApp(db, sessions, users)
    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/renditions/1.m3u8`,
      headers: tokenHeader(db, owner.id, session.reconnectToken),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('mpegurl')
  })
})

describe('playlist routes reconnect token (#41)', () => {
  it('rejects GET stream.m3u8 without the reconnect token with 400 invalid-reconnect-token', async () => {
    const { db, owner, sessions, users, session } = makeSession(2)
    app = await buildApp(db, sessions, users)
    const res = await app.inject({ method: 'GET', url: `/sessions/${session.id}/stream.m3u8`, headers: bearer(db, owner.id) })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-reconnect-token')
  })

  it('rejects GET renditions/:r.m3u8 without the reconnect token with 400 invalid-reconnect-token', async () => {
    const { db, owner, sessions, users, session } = makeSession(2)
    app = await buildApp(db, sessions, users)
    const res = await app.inject({ method: 'GET', url: `/sessions/${session.id}/renditions/1.m3u8`, headers: bearer(db, owner.id) })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-reconnect-token')
  })

  it('serves stream.m3u8 with the correct token', async () => {
    const { db, owner, sessions, users, session } = makeSession(2)
    app = await buildApp(db, sessions, users)
    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/stream.m3u8`,
      headers: tokenHeader(db, owner.id, session.reconnectToken),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('mpegurl')
  })
})

describe('playlist routes userId ownership (#41)', () => {
  // Reconnect-token header plus an authenticated session bearer for `userId`.
  const userHeaders = (db: DatabaseSync, token: string, userId: string) => ({
    'x-reconnect-token': token,
    ...bearer(db, userId),
  })

  for (const route of ['stream.m3u8', 'renditions/1.m3u8'] as const) {
    describe(`GET /sessions/:id/${route}`, () => {
      it('rejects a member who does not own the session with 403 caller-forbidden', async () => {
        const { db, owner, sessions, users, session, other } = makeSession(2, { ownedByMember: true })
        app = await buildApp(db, sessions, users)
        const res = await app.inject({
          method: 'GET',
          url: `/sessions/${session.id}/${route}`,
          headers: userHeaders(db, session.reconnectToken, other.id),
        })
        expect(res.statusCode).toBe(403)
        expect(res.json().code).toBe('caller-forbidden')
      })

      it('rejects an owned session when the request is unauthenticated (401)', async () => {
        const { db, sessions, users, session } = makeSession(2, { ownedByMember: true })
        app = await buildApp(db, sessions, users)
        const res = await app.inject({
          method: 'GET',
          url: `/sessions/${session.id}/${route}`,
          headers: { 'x-reconnect-token': session.reconnectToken },
        })
        expect(res.statusCode).toBe(401)
        expect(res.json().code).toBe('unauthorized')
      })

      it('allows the session owner', async () => {
        const { db, owner, sessions, users, session, member } = makeSession(2, { ownedByMember: true })
        app = await buildApp(db, sessions, users)
        const res = await app.inject({
          method: 'GET',
          url: `/sessions/${session.id}/${route}`,
          headers: userHeaders(db, session.reconnectToken, member.id),
        })
        expect(res.statusCode).toBe(200)
        expect(res.headers['content-type']).toContain('mpegurl')
      })

      it('allows an admin to access a session owned by someone else', async () => {
        const { db, owner, sessions, users, session, admin } = makeSession(2, { ownedByMember: true })
        app = await buildApp(db, sessions, users)
        const res = await app.inject({
          method: 'GET',
          url: `/sessions/${session.id}/${route}`,
          headers: userHeaders(db, session.reconnectToken, admin.id),
        })
        expect(res.statusCode).toBe(200)
      })

      it('allows any authenticated user to access a headless (userId=null) session', async () => {
        const { db, owner, sessions, users, session } = makeSession(2, { userId: null })
        app = await buildApp(db, sessions, users)
        const res = await app.inject({
          method: 'GET',
          url: `/sessions/${session.id}/${route}`,
          headers: tokenHeader(db, owner.id, session.reconnectToken),
        })
        expect(res.statusCode).toBe(200)
      })
    })
  }
})
