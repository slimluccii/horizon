import { describe, it, expect, afterEach } from 'vitest'
import Fastify from 'fastify'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase, type DatabaseSync } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createServerSettings } from '../src/contexts/settings/index.ts'
import { createMediaRepo, type MovieUpsert } from '../src/contexts/library/index.ts'
import { createUserRepo } from '../src/contexts/identity/index.ts'
import { createSessionRepo } from '../src/contexts/identity/index.ts'
import { makeRequireAuth } from '../src/contexts/identity/index.ts'
import { createSessionManager } from '../src/session/manager.ts'
import { registerSegments } from '../src/routes/segments.ts'
import type { HwAccel } from '../src/transcode/hwaccel.ts'
import type { PlaybackPlan } from '../src/transcode/plan.ts'

const hwAccel = { name: 'cpu' } as unknown as HwAccel

function plan(renditionCount: number): PlaybackPlan {
  return {
    method: renditionCount === 0 ? 'direct-play' : 'transcode',
    renditions: Array.from({ length: renditionCount }, (_, i) => ({
      profile: { name: `r${i}` },
    })),
  } as unknown as PlaybackPlan
}

function movie(partial: Partial<MovieUpsert> = {}): MovieUpsert {
  return {
    id: 'm1',
    filePath: '/x/Movie.mkv',
    title: 'Movie',
    sortYear: 2023,
    durationSec: 100,
    resolution: '1920x1080',
    videoCodec: 'h264',
    container: 'matroska',
    hdr: { dv: false, hdr10: false, hdr10plus: false },
    audioTracks: [],
    subtitleTracks: [],
    mtimeMs: 1000,
    sizeBytes: 1000,
    externalIds: {},
    metadata: null,
    ...partial,
  }
}

function setup(opts: { renditionCount: number; subtitleTracks?: number; userId?: string | null; ownedByMember?: boolean } = { renditionCount: 2 }) {
  const db = openDatabase(':memory:')
  migrate(db)
  const serverSettings = createServerSettings(db)
  const media = createMediaRepo(db)
  const users = createUserRepo(db)
  const owner = users.create({ name: 'Alice' }) // auto-elected owner
  const admin = users.update(users.create({ name: 'Bob' }).id, { role: 'admin' })!
  const member = users.create({ name: 'Carol' }) // default member
  const other = users.create({ name: 'Dave' }) // another member
  const sessionDir = mkdtempSync(path.join(tmpdir(), 'horizon-seg-'))
  media.upsertMovie(movie({
    id: 'm1',
    subtitleTracks: Array.from({ length: opts.subtitleTracks ?? 0 }, (_, i) => ({
      index: i, codec: 'subrip', language: 'en', forced: false, embeddable: true,
    })),
  }))
  const sessions = createSessionManager(serverSettings)
  // Default to a headless session (no owner) so the long-standing
  // token/bounds tests are unaffected by the ownership gate. Ownership tests
  // set ownedByMember (session owned by `member`) or pass an explicit userId.
  const userId = opts.ownedByMember ? member.id : (opts.userId === undefined ? null : opts.userId)
  const session = sessions.create({
    mediaId: 'm1',
    filePath: '/x/Movie.mkv',
    plan: plan(opts.renditionCount),
    selectedSubtitleTrack: null,
    audioTrackCount: 1,
    subtitleTrackCount: opts.subtitleTracks ?? 0,
    renditionCodecs: [],
    sessionDir,
    sessionReady: true,
    durationSec: 100,
    userId: userId ?? undefined,
  } as unknown as Parameters<typeof sessions.create>[0])
  return { db, sessions, media, users, session, sessionDir, owner, admin, member, other }
}

async function buildApp(
  db: DatabaseSync,
  sessions: ReturnType<typeof createSessionManager>,
  media: ReturnType<typeof createMediaRepo>,
  users: ReturnType<typeof createUserRepo>,
) {
  const app = Fastify({ logger: false })
  app.addHook('onRequest', makeRequireAuth(createSessionRepo(db), users))
  registerSegments(app, hwAccel, sessions, media, users)
  await app.ready()
  return app
}

let app: Awaited<ReturnType<typeof buildApp>> | undefined
afterEach(async () => { if (app) { await app.close(); app = undefined } })

/** Session bearer header for a user id (authenticates the request). */
function bearer(db: DatabaseSync, userId: string): { authorization: string } {
  return { authorization: `Bearer ${createSessionRepo(db).issue(userId).token}` }
}

/** Reconnect-token header plus an authenticated owner session bearer. Most
 *  segment tests run against a headless session and only care about the
 *  reconnect-token / bounds logic, so they authenticate as the owner. */
const tokenHeader = (db: DatabaseSync, ownerId: string, token: string) => ({
  'x-reconnect-token': token,
  ...bearer(db, ownerId),
})

describe('GET /sessions/:id/renditions/:r/:seg reconnect token (#78)', () => {
  it('rejects a request without the reconnect token header with 400 invalid-reconnect-token', async () => {
    const { db, owner, sessions, media, users, session } = setup({ renditionCount: 2 })
    app = await buildApp(db, sessions, media, users)
    const res = await app.inject({ method: 'GET', url: `/sessions/${session.id}/renditions/0/init.mp4`, headers: bearer(db, owner.id) })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-reconnect-token')
  })

  it('rejects a request with a mismatched reconnect token with 400 invalid-reconnect-token', async () => {
    const { db, owner, sessions, media, users, session } = setup({ renditionCount: 2 })
    app = await buildApp(db, sessions, media, users)
    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/renditions/0/init.mp4`,
      headers: tokenHeader(db, owner.id, 'wrong-token'),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-reconnect-token')
  })

  it('serves an init segment that exists on disk with the correct token', async () => {
    const { db, owner, sessions, media, users, session, sessionDir } = setup({ renditionCount: 2 })
    const { mkdirSync } = await import('node:fs')
    mkdirSync(path.join(sessionDir, 'r0'), { recursive: true })
    writeFileSync(path.join(sessionDir, 'r0', 'init.mp4'), 'fakeinit')
    app = await buildApp(db, sessions, media, users)
    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/renditions/0/init.mp4`,
      headers: tokenHeader(db, owner.id, session.reconnectToken),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('video/mp4')
  })
})

describe('GET /sessions/:id/renditions/:r/:seg rendition bounds (#86)', () => {
  it('rejects r >= plan.renditions.length with 400 invalid-input', async () => {
    const { db, owner, sessions, media, users, session } = setup({ renditionCount: 2 })
    app = await buildApp(db, sessions, media, users)
    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/renditions/2/init.mp4`,
      headers: tokenHeader(db, owner.id, session.reconnectToken),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('rejects every rendition for a direct-play session (0 renditions)', async () => {
    const { db, owner, sessions, media, users, session } = setup({ renditionCount: 0 })
    app = await buildApp(db, sessions, media, users)
    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/renditions/0/init.mp4`,
      headers: tokenHeader(db, owner.id, session.reconnectToken),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })
})

describe('GET /sessions/:id/subtitles/:trackIdx.vtt bounds (#89)', () => {
  it('rejects trackIdx >= subtitleTracks.length with 400 invalid-input (not 404)', async () => {
    const { db, owner, sessions, media, users, session } = setup({ renditionCount: 2, subtitleTracks: 2 })
    app = await buildApp(db, sessions, media, users)
    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/subtitles/999.vtt`,
      headers: tokenHeader(db, owner.id, session.reconnectToken),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('rejects all subtitle indices when the media has 0 subtitle tracks', async () => {
    const { db, owner, sessions, media, users, session } = setup({ renditionCount: 2, subtitleTracks: 0 })
    app = await buildApp(db, sessions, media, users)
    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/subtitles/0.vtt`,
      headers: tokenHeader(db, owner.id, session.reconnectToken),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('serves a VTT for an in-bounds track that exists on disk (happy path)', async () => {
    const { db, owner, sessions, media, users, session, sessionDir } = setup({ renditionCount: 2, subtitleTracks: 2 })
    writeFileSync(path.join(sessionDir, 'sub_0.vtt'), 'WEBVTT\n\n')
    app = await buildApp(db, sessions, media, users)
    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/subtitles/0.vtt`,
      headers: tokenHeader(db, owner.id, session.reconnectToken),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/vtt')
  })
})

describe('GET /sessions/:id/subtitles/:trackIdx.vtt reconnect token (#41)', () => {
  it('rejects a request without the reconnect token with 400 invalid-reconnect-token', async () => {
    const { db, owner, sessions, media, users, session, sessionDir } = setup({ renditionCount: 2, subtitleTracks: 2 })
    writeFileSync(path.join(sessionDir, 'sub_0.vtt'), 'WEBVTT\n\n')
    app = await buildApp(db, sessions, media, users)
    const res = await app.inject({ method: 'GET', url: `/sessions/${session.id}/subtitles/0.vtt`, headers: bearer(db, owner.id) })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-reconnect-token')
  })

  it('accepts the reconnect token via the `token` query param (header-less <track src>), with the session cookie riding the request', async () => {
    const { db, owner, sessions, media, users, session, sessionDir } = setup({ renditionCount: 2, subtitleTracks: 2 })
    writeFileSync(path.join(sessionDir, 'sub_0.vtt'), 'WEBVTT\n\n')
    app = await buildApp(db, sessions, media, users)
    const token = createSessionRepo(db).issue(owner.id).token
    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/subtitles/0.vtt?token=${session.reconnectToken}`,
      headers: { cookie: `hz_session=${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/vtt')
  })
})

describe('GET /sessions/:id/direct reconnect token (#41)', () => {
  function directSetup() {
    // direct-play session backed by a real on-disk file so statSync succeeds.
    const ctx = setup({ renditionCount: 0 })
    const filePath = path.join(ctx.sessionDir, 'movie.mkv')
    writeFileSync(filePath, 'fakebytes')
    ctx.session.filePath = filePath
    return ctx
  }

  it('rejects a request without the reconnect token with 400 invalid-reconnect-token', async () => {
    const { db, owner, sessions, media, users, session } = directSetup()
    app = await buildApp(db, sessions, media, users)
    const res = await app.inject({ method: 'GET', url: `/sessions/${session.id}/direct`, headers: bearer(db, owner.id) })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-reconnect-token')
  })

  it('rejects a mismatched token with 400 invalid-reconnect-token', async () => {
    const { db, owner, sessions, media, users, session } = directSetup()
    app = await buildApp(db, sessions, media, users)
    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/direct`,
      headers: tokenHeader(db, owner.id, 'wrong-token'),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-reconnect-token')
  })

  it('serves bytes with the correct reconnect token via the `token` query param (session cookie riding)', async () => {
    const { db, owner, sessions, media, users, session } = directSetup()
    app = await buildApp(db, sessions, media, users)
    const cookieTok = createSessionRepo(db).issue(owner.id).token
    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/direct?token=${session.reconnectToken}`,
      headers: { cookie: `hz_session=${cookieTok}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('video/x-matroska')
  })
})

describe('segment routes userId ownership (#41)', () => {
  // Reconnect-token header plus an authenticated session bearer for `userId`.
  const userHeaders = (db: DatabaseSync, token: string, userId: string) => ({
    'x-reconnect-token': token,
    ...bearer(db, userId),
  })

  describe('GET /sessions/:id/renditions/:r/:seg', () => {
    it('rejects a member who does not own the session with 403 caller-forbidden', async () => {
      const { db, owner, sessions, media, users, session, member, other } = setup({ renditionCount: 2, ownedByMember: true })
      app = await buildApp(db, sessions, media, users)
      const res = await app.inject({
        method: 'GET',
        url: `/sessions/${session.id}/renditions/0/init.mp4`,
        headers: userHeaders(db, session.reconnectToken, other.id),
      })
      expect(res.statusCode).toBe(403)
      expect(res.json().code).toBe('caller-forbidden')
    })

    it('allows the session owner (matching userId) through the ownership gate', async () => {
      const { db, owner, sessions, media, users, session, sessionDir, member } = setup({ renditionCount: 2, ownedByMember: true })
      const { mkdirSync } = await import('node:fs')
      mkdirSync(path.join(sessionDir, 'r0'), { recursive: true })
      writeFileSync(path.join(sessionDir, 'r0', 'init.mp4'), 'fakeinit')
      app = await buildApp(db, sessions, media, users)
      const res = await app.inject({
        method: 'GET',
        url: `/sessions/${session.id}/renditions/0/init.mp4`,
        headers: userHeaders(db, session.reconnectToken, member.id),
      })
      expect(res.statusCode).toBe(200)
    })

    it('allows an admin to access a session owned by someone else', async () => {
      const { db, owner, sessions, media, users, session, sessionDir, member, admin } = setup({ renditionCount: 2, ownedByMember: true })
      const { mkdirSync } = await import('node:fs')
      mkdirSync(path.join(sessionDir, 'r0'), { recursive: true })
      writeFileSync(path.join(sessionDir, 'r0', 'init.mp4'), 'fakeinit')
      app = await buildApp(db, sessions, media, users)
      const res = await app.inject({
        method: 'GET',
        url: `/sessions/${session.id}/renditions/0/init.mp4`,
        headers: userHeaders(db, session.reconnectToken, admin.id),
      })
      expect(res.statusCode).toBe(200)
    })

    it('allows access to a headless (userId=null) session with no user header', async () => {
      const { db, owner, sessions, media, users, session, sessionDir } = setup({ renditionCount: 2, userId: null })
      const { mkdirSync } = await import('node:fs')
      mkdirSync(path.join(sessionDir, 'r0'), { recursive: true })
      writeFileSync(path.join(sessionDir, 'r0', 'init.mp4'), 'fakeinit')
      app = await buildApp(db, sessions, media, users)
      const res = await app.inject({
        method: 'GET',
        url: `/sessions/${session.id}/renditions/0/init.mp4`,
        headers: tokenHeader(db, owner.id, session.reconnectToken),
      })
      expect(res.statusCode).toBe(200)
    })

    it('rejects an owned session when the request is unauthenticated (401)', async () => {
      const { db, sessions, media, users, session } = setup({ renditionCount: 2, ownedByMember: true })
      app = await buildApp(db, sessions, media, users)
      const res = await app.inject({
        method: 'GET',
        url: `/sessions/${session.id}/renditions/0/init.mp4`,
        headers: { 'x-reconnect-token': session.reconnectToken },
      })
      expect(res.statusCode).toBe(401)
      expect(res.json().code).toBe('unauthorized')
    })
  })

  describe('GET /sessions/:id/direct', () => {
    // owned: session.userId is set to ctx.member; headless: userId=null. The
    // backing file is written to disk so statSync in the route succeeds.
    function directSetup(opts: { headless?: boolean } = {}) {
      const ctx = setup({ renditionCount: 0, userId: null })
      // Set ownership to ctx.member (the live Session object is mutable and the
      // route reads session.userId at request time).
      ctx.session.userId = opts.headless ? undefined : ctx.member.id
      const filePath = path.join(ctx.sessionDir, 'movie.mkv')
      writeFileSync(filePath, 'fakebytes')
      ctx.session.filePath = filePath
      return ctx
    }

    it('rejects a non-owner member with 403 caller-forbidden', async () => {
      const owned = directSetup()
      app = await buildApp(owned.db, owned.sessions, owned.media, owned.users)
      const res = await app.inject({
        method: 'GET',
        url: `/sessions/${owned.session.id}/direct`,
        headers: userHeaders(owned.db, owned.session.reconnectToken, owned.other.id),
      })
      expect(res.statusCode).toBe(403)
      expect(res.json().code).toBe('caller-forbidden')
    })

    it('allows the owner', async () => {
      const owned = directSetup()
      app = await buildApp(owned.db, owned.sessions, owned.media, owned.users)
      const res = await app.inject({
        method: 'GET',
        url: `/sessions/${owned.session.id}/direct`,
        headers: userHeaders(owned.db, owned.session.reconnectToken, owned.member.id),
      })
      expect(res.statusCode).toBe(200)
    })

    it('allows an admin for another user\'s session', async () => {
      const owned = directSetup()
      app = await buildApp(owned.db, owned.sessions, owned.media, owned.users)
      const res = await app.inject({
        method: 'GET',
        url: `/sessions/${owned.session.id}/direct`,
        headers: userHeaders(owned.db, owned.session.reconnectToken, owned.admin.id),
      })
      expect(res.statusCode).toBe(200)
    })

    it('allows any authenticated user on a headless session', async () => {
      const ctx = directSetup({ headless: true })
      app = await buildApp(ctx.db, ctx.sessions, ctx.media, ctx.users)
      const res = await app.inject({
        method: 'GET',
        url: `/sessions/${ctx.session.id}/direct`,
        headers: tokenHeader(ctx.db, ctx.owner.id, ctx.session.reconnectToken),
      })
      expect(res.statusCode).toBe(200)
    })

    // Browser path: a `<video src>` cannot set headers, so the reconnect token
    // rides as a `token` query param while the httpOnly hz_session cookie carries
    // identity (the `?user=` identity hack is gone). Regression for the playback
    // hang where the owner's browser direct-play used to 403.
    it('allows the owner via token query param with the session cookie riding (browser path)', async () => {
      const owned = directSetup()
      app = await buildApp(owned.db, owned.sessions, owned.media, owned.users)
      const cookieTok = createSessionRepo(owned.db).issue(owned.member.id).token
      const res = await app.inject({
        method: 'GET',
        url: `/sessions/${owned.session.id}/direct?token=${owned.session.reconnectToken}`,
        headers: { cookie: `hz_session=${cookieTok}` },
      })
      expect(res.statusCode).toBe(200)
    })
  })

  describe('GET /sessions/:id/subtitles/:trackIdx.vtt', () => {
    it('rejects a non-owner member with 403 caller-forbidden', async () => {
      const { db, owner, sessions, media, users, session, sessionDir, member, other } = setup({ renditionCount: 2, subtitleTracks: 2, ownedByMember: true })
      writeFileSync(path.join(sessionDir, 'sub_0.vtt'), 'WEBVTT\n\n')
      app = await buildApp(db, sessions, media, users)
      const res = await app.inject({
        method: 'GET',
        url: `/sessions/${session.id}/subtitles/0.vtt`,
        headers: userHeaders(db, session.reconnectToken, other.id),
      })
      expect(res.statusCode).toBe(403)
      expect(res.json().code).toBe('caller-forbidden')
    })

    it('allows the owner, an admin, and a headless session', async () => {
      // owner
      {
        const { db, owner, sessions, media, users, session, sessionDir, member } = setup({ renditionCount: 2, subtitleTracks: 2, ownedByMember: true })
        writeFileSync(path.join(sessionDir, 'sub_0.vtt'), 'WEBVTT\n\n')
        const a = await buildApp(db, sessions, media, users)
        const res = await a.inject({
          method: 'GET',
          url: `/sessions/${session.id}/subtitles/0.vtt`,
          headers: userHeaders(db, session.reconnectToken, member.id),
        })
        expect(res.statusCode).toBe(200)
        await a.close()
      }
      // admin
      {
        const { db, owner, sessions, media, users, session, sessionDir, member, admin } = setup({ renditionCount: 2, subtitleTracks: 2, ownedByMember: true })
        writeFileSync(path.join(sessionDir, 'sub_0.vtt'), 'WEBVTT\n\n')
        const a = await buildApp(db, sessions, media, users)
        const res = await a.inject({
          method: 'GET',
          url: `/sessions/${session.id}/subtitles/0.vtt`,
          headers: userHeaders(db, session.reconnectToken, admin.id),
        })
        expect(res.statusCode).toBe(200)
        await a.close()
      }
      // headless
      {
        const { db, owner, sessions, media, users, session, sessionDir } = setup({ renditionCount: 2, subtitleTracks: 2, userId: null })
        writeFileSync(path.join(sessionDir, 'sub_0.vtt'), 'WEBVTT\n\n')
        app = await buildApp(db, sessions, media, users)
        const res = await app.inject({
          method: 'GET',
          url: `/sessions/${session.id}/subtitles/0.vtt`,
          headers: tokenHeader(db, owner.id, session.reconnectToken),
        })
        expect(res.statusCode).toBe(200)
      }
    })
  })
})
