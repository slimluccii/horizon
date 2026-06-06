import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import fastifyWebSocket from '@fastify/websocket'
import { WebSocket } from 'ws'
import { openDatabase, type DatabaseSync } from '../../../../platform/db/connection.ts'
import { migrate } from '../../../../platform/db/migrations.ts'
import { createUserRepo } from '../../../identity/index.ts'
import { createSessionRepo } from '../../../identity/index.ts'
import { makeRequireAuth, makeResolveProfile } from '../../../identity/index.ts'
import { createServerSettings } from '../../../settings/index.ts'
import { createSessionManager } from '../../application/manager.ts'
import { registerSessions } from './sessions.ts'
import type { HwAccel } from '../../domain/hwaccel.ts'
import type { ProgressRepo } from '../persistence/progress.ts'
import type { Config } from '../../../../platform/config/config.ts'
import type {
  PlaybackOrchestrator,
  StartPlaybackInput,
  StartPlaybackResult,
} from '../../application/playback.ts'

const hwAccel = { name: 'cpu' } as unknown as HwAccel

function setup() {
  const db = openDatabase(':memory:')
  migrate(db)
  const users = createUserRepo(db)
  const serverSettings = createServerSettings(db)
  const owner = users.create({ name: 'Alice' }) // auto-elected owner
  const admin = users.update(users.create({ name: 'Bob' }).id, { role: 'admin' })!
  const member = users.create({ name: 'Carol' }) // default member
  return { db, users, serverSettings, owner, admin, member }
}

/** Records the userId the route passed through, returns a no-op session. */
function fakeOrchestrator() {
  const calls: StartPlaybackInput[] = []
  const orch: PlaybackOrchestrator = {
    startPlayback(input): StartPlaybackResult {
      calls.push(input)
      return {
        info: {
          sessionId: 's1',
          method: 'direct-play',
          streamUrl: '/sessions/s1/direct',
          wsUrl: '/sessions/s1/ws',
          profiles: [],
          selectedAudioTrack: 0,
          selectedSubtitleTrack: null,
          reconnectToken: 'tok',
        },
        ready: Promise.resolve(),
      }
    },
  }
  return Object.assign(orch, { calls })
}

async function buildApp(
  db: DatabaseSync,
  users: ReturnType<typeof setup>['users'],
  serverSettings: ReturnType<typeof setup>['serverSettings'],
  orchestrator: PlaybackOrchestrator,
) {
  const app = Fastify({ logger: false })
  app.addHook('onRequest', makeRequireAuth(createSessionRepo(db), users))
  const sessions = createSessionManager(serverSettings)
  const progressRepo = {} as ProgressRepo
  const cfg = {} as Config
  registerSessions(app, cfg, hwAccel, sessions, progressRepo, orchestrator, serverSettings, users)
  await app.ready()
  return app
}

/** Like buildApp, but also installs the resolveProfile preHandler so
 *  req.profileUserId is populated — exercising the active-profile path of
 *  POST /sessions (Task 14). */
async function buildAppWithProfile(
  db: DatabaseSync,
  users: ReturnType<typeof setup>['users'],
  serverSettings: ReturnType<typeof setup>['serverSettings'],
  orchestrator: PlaybackOrchestrator,
) {
  const app = Fastify({ logger: false })
  app.addHook('onRequest', makeRequireAuth(createSessionRepo(db), users))
  app.addHook('preHandler', makeResolveProfile(createSessionRepo(db), users))
  const sessions = createSessionManager(serverSettings)
  const progressRepo = {} as ProgressRepo
  const cfg = {} as Config
  registerSessions(app, cfg, hwAccel, sessions, progressRepo, orchestrator, serverSettings, users)
  await app.ready()
  return app
}

/** Session bearer header for a user id, with an act-as grant. */
function hdrGrant(db: DatabaseSync, userId: string, grant: string[]): { authorization: string } {
  return { authorization: `Bearer ${createSessionRepo(db).issue(userId, null, grant).token}` }
}

/** Builds an app and exposes the live SessionManager so DELETE tests can seed a
 *  real session (the fakeOrchestrator never registers one with the manager). */
async function buildAppWithManager(
  db: DatabaseSync,
  users: ReturnType<typeof setup>['users'],
  serverSettings: ReturnType<typeof setup>['serverSettings'],
  orchestrator: PlaybackOrchestrator,
) {
  const app = Fastify({ logger: false })
  app.addHook('onRequest', makeRequireAuth(createSessionRepo(db), users))
  const sessions = createSessionManager(serverSettings)
  const progressRepo = {} as ProgressRepo
  const cfg = {} as Config
  registerSessions(app, cfg, hwAccel, sessions, progressRepo, orchestrator, serverSettings, users)
  await app.ready()
  return { app, sessions }
}

/** Builds a *listening* app with the WS plugin so a real WebSocket client can
 *  exercise the upgrade-handler authz (inject() cannot perform WS upgrades). */
async function buildListeningApp(
  db: DatabaseSync,
  users: ReturnType<typeof setup>['users'],
  serverSettings: ReturnType<typeof setup>['serverSettings'],
  orchestrator: PlaybackOrchestrator,
) {
  const app = Fastify({ logger: false })
  await app.register(fastifyWebSocket)
  app.addHook('onRequest', makeRequireAuth(createSessionRepo(db), users))
  const sessions = createSessionManager(serverSettings)
  const progressRepo = { flush() {}, get() { return undefined } } as unknown as ProgressRepo
  const cfg = {} as Config
  registerSessions(app, cfg, hwAccel, sessions, progressRepo, orchestrator, serverSettings, users)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { app, sessions, port }
}

/** Session bearer header for a user id. */
function hdr(db: DatabaseSync, userId: string): { authorization: string } {
  return { authorization: `Bearer ${createSessionRepo(db).issue(userId).token}` }
}

/**
 * Opens a WS to /sessions/:id/ws and reports the outcome. With
 * @fastify/websocket the HTTP upgrade completes (101) before our route runs,
 * so the client always sees `open` first; an authz rejection then arrives as a
 * server-initiated close with code 4001. We therefore key off the close code:
 * `rejected` is true when the SERVER closed with 4001, and we capture whether a
 * `session-ready` frame (proof the handler ran the happy path) arrived first.
 */
function connectWs(
  port: number,
  sessionId: string,
  // A session bearer token to authenticate the upgrade. Post-cutover the WS
  // upgrade carries identity via the `hz_session` cookie (browser) or
  // `Authorization: Bearer` (native) — there is no `?user=` query hack anymore.
  // We send the token as a cookie to mirror the browser path. Omit it to
  // exercise the unauthenticated case (the auth hook rejects the upgrade).
  token?: string,
  via: 'cookie' | 'bearer' = 'cookie',
): Promise<{ rejected: boolean; code?: number; gotServerFrame: boolean; authFailed: boolean }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {}
    if (token && via === 'cookie') headers.cookie = `hz_session=${token}`
    if (token && via === 'bearer') headers.authorization = `Bearer ${token}`
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sessions/${sessionId}/ws`, { headers })
    let gotServerFrame = false
    let authFailed = false
    // For the allowed path the handler keeps the socket open; close it from the
    // client after a tick so the promise resolves with a non-4001 code.
    ws.on('open', () => setTimeout(() => ws.close(), 50))
    ws.on('message', () => { gotServerFrame = true })
    // The auth-hook 401 aborts the HTTP upgrade — ws surfaces it as
    // 'unexpected-response' (no 'close' follows), so resolve from here.
    ws.on('unexpected-response', () => { authFailed = true; resolve({ rejected: true, gotServerFrame, authFailed }) })
    ws.on('close', (code) => resolve({ rejected: code === 4001, code, gotServerFrame, authFailed }))
    ws.on('error', () => { /* a close/unexpected-response event follows */ })
  })
}

function seedSession(
  sessions: ReturnType<typeof createSessionManager>,
  userId?: string,
) {
  return sessions.create({
    mediaId: 'm1',
    filePath: '/tmp/x.mkv',
    // A single-rendition transcode plan so the WS handler's session-ready send
    // (which dereferences renditions[0].profile) succeeds on attach.
    plan: { method: 'transcode', renditions: [{ profile: { name: '1080p' } }] },
    selectedSubtitleTrack: null,
    audioTrackCount: 1,
    subtitleTrackCount: 0,
    renditionCodecs: [],
    sessionDir: '/tmp/sess-del',
    sessionReady: true,
    durationSec: 100,
    userId,
  } as unknown as Parameters<typeof sessions.create>[0])
}

const body = (extra: Record<string, unknown> = {}) => ({
  mediaId: 'm1',
  capabilities: { videoCodecs: ['h264'], audioCodecs: ['aac'], hdr: [], maxBitrate: 8000, container: ['mp4'] },
  ...extra,
})

describe('POST /sessions auth', () => {
  it('returns 401 unauthorized when no session is present', async () => {
    const { db, users, serverSettings } = setup()
    const orch = fakeOrchestrator()
    const app = await buildApp(db, users, serverSettings, orch)
    const res = await app.inject({ method: 'POST', url: '/sessions', payload: body() })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthorized')
    expect(orch.calls).toHaveLength(0)
  })

  it('returns 401 unauthorized for an invalid session token', async () => {
    const { db, users, serverSettings } = setup()
    const orch = fakeOrchestrator()
    const app = await buildApp(db, users, serverSettings, orch)
    const res = await app.inject({
      method: 'POST', url: '/sessions', payload: body(),
      headers: { authorization: 'Bearer not-a-real-token' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthorized')
  })

  it('succeeds with valid header and no userId in body, defaulting userId to caller', async () => {
    const { db, users, serverSettings, member } = setup()
    const orch = fakeOrchestrator()
    const app = await buildApp(db, users, serverSettings, orch)
    const res = await app.inject({
      method: 'POST', url: '/sessions', payload: body(),
      headers: hdr(db, member.id),
    })
    expect(res.statusCode).toBe(200)
    expect(orch.calls[0].userId).toBe(member.id)
  })

  it('succeeds when userId matches the caller', async () => {
    const { db, users, serverSettings, member } = setup()
    const orch = fakeOrchestrator()
    const app = await buildApp(db, users, serverSettings, orch)
    const res = await app.inject({
      method: 'POST', url: '/sessions', payload: body({ userId: member.id }),
      headers: hdr(db, member.id),
    })
    expect(res.statusCode).toBe(200)
    expect(orch.calls[0].userId).toBe(member.id)
  })

  it('returns 403 caller-forbidden when a member delegates to another user', async () => {
    const { db, users, serverSettings, member, owner } = setup()
    const orch = fakeOrchestrator()
    const app = await buildApp(db, users, serverSettings, orch)
    const res = await app.inject({
      method: 'POST', url: '/sessions', payload: body({ userId: owner.id }),
      headers: hdr(db, member.id),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
    expect(orch.calls).toHaveLength(0)
  })

  it('allows owner/admin to delegate playback for another user', async () => {
    const { db, users, serverSettings, admin, member } = setup()
    const orch = fakeOrchestrator()
    const app = await buildApp(db, users, serverSettings, orch)
    const res = await app.inject({
      method: 'POST', url: '/sessions', payload: body({ userId: member.id }),
      headers: hdr(db, admin.id),
    })
    expect(res.statusCode).toBe(200)
    expect(orch.calls[0].userId).toBe(member.id)
  })

  it('keys the session user off the active profile, not the body/caller', async () => {
    // Principal is the member, but the session is granted to act as the owner
    // and X-Horizon-Profile selects the owner. The session must be created for
    // the OWNER — the acting user comes from req.profileUserId.
    const { db, users, serverSettings, member, owner } = setup()
    const orch = fakeOrchestrator()
    const app = await buildAppWithProfile(db, users, serverSettings, orch)
    const res = await app.inject({
      method: 'POST', url: '/sessions', payload: body(),
      headers: {
        ...hdrGrant(db, member.id, [member.id, owner.id]),
        'x-horizon-profile': owner.id,
      },
    })
    expect(res.statusCode).toBe(200)
    expect(orch.calls[0].userId).toBe(owner.id)
  })

  it('rejects a body userId that disagrees with the active profile (403 user-mismatch)', async () => {
    const { db, users, serverSettings, member, owner } = setup()
    const orch = fakeOrchestrator()
    const app = await buildAppWithProfile(db, users, serverSettings, orch)
    const res = await app.inject({
      method: 'POST', url: '/sessions', payload: body({ userId: member.id }),
      headers: {
        ...hdrGrant(db, member.id, [member.id, owner.id]),
        'x-horizon-profile': owner.id,
      },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('user-mismatch')
    expect(orch.calls).toHaveLength(0)
  })

  it('returns 400 invalid-input for a negative audioTrackIndex (Zod)', async () => {
    const { db, users, serverSettings, member } = setup()
    const orch = fakeOrchestrator()
    const app = await buildApp(db, users, serverSettings, orch)
    const res = await app.inject({
      method: 'POST', url: '/sessions', payload: body({ audioTrackIndex: -1 }),
      headers: hdr(db, member.id),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
    expect(orch.calls).toHaveLength(0)
  })

  it('returns 400 invalid-input for a non-integer startPositionMs (Zod)', async () => {
    const { db, users, serverSettings, member } = setup()
    const orch = fakeOrchestrator()
    const app = await buildApp(db, users, serverSettings, orch)
    const res = await app.inject({
      method: 'POST', url: '/sessions', payload: body({ startPositionMs: 1.5 }),
      headers: hdr(db, member.id),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('returns 400 invalid-input for unknown keys (.strict)', async () => {
    const { db, users, serverSettings, member } = setup()
    const orch = fakeOrchestrator()
    const app = await buildApp(db, users, serverSettings, orch)
    const res = await app.inject({
      method: 'POST', url: '/sessions', payload: body({ bogus: true }),
      headers: hdr(db, member.id),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('maps invalid-input from the orchestrator to HTTP 400', async () => {
    const { db, users, serverSettings, member } = setup()
    const orch: PlaybackOrchestrator = {
      startPlayback() {
        throw Object.assign(new Error('Start position exceeds media duration'), { code: 'invalid-input' })
      },
    }
    const app = await buildApp(db, users, serverSettings, orch)
    const res = await app.inject({
      method: 'POST', url: '/sessions', payload: body({ startPositionMs: 999 }),
      headers: hdr(db, member.id),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('maps audio-track-invalid from the orchestrator to HTTP 400', async () => {
    const { db, users, serverSettings, member } = setup()
    const orch: PlaybackOrchestrator = {
      startPlayback() {
        throw Object.assign(new Error('Audio track index out of bounds'), { code: 'audio-track-invalid' })
      },
    }
    const app = await buildApp(db, users, serverSettings, orch)
    const res = await app.inject({
      method: 'POST', url: '/sessions', payload: body({ audioTrackIndex: 99 }),
      headers: hdr(db, member.id),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('audio-track-invalid')
  })
})

describe('DELETE /sessions/:id reconnect token (#41)', () => {
  it('rejects a DELETE without the reconnect token with 400 and does NOT destroy', async () => {
    const { db, users, serverSettings, owner } = setup()
    const { app, sessions } = await buildAppWithManager(db, users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions)
    const res = await app.inject({ method: 'DELETE', url: `/sessions/${session.id}`, headers: hdr(db, owner.id) })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-reconnect-token')
    expect(sessions.get(session.id)).toBeDefined() // still alive
    await app.close()
  })

  it('rejects a DELETE with a mismatched token with 400 and does NOT destroy', async () => {
    const { db, users, serverSettings, owner } = setup()
    const { app, sessions } = await buildAppWithManager(db, users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions)
    const res = await app.inject({
      method: 'DELETE', url: `/sessions/${session.id}`,
      headers: { 'x-reconnect-token': 'wrong-token', ...hdr(db, owner.id) },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-reconnect-token')
    expect(sessions.get(session.id)).toBeDefined()
    await app.close()
  })

  it('destroys the session with the correct token (204)', async () => {
    const { db, users, serverSettings, owner } = setup()
    const { app, sessions } = await buildAppWithManager(db, users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions)
    const res = await app.inject({
      method: 'DELETE', url: `/sessions/${session.id}`,
      headers: { 'x-reconnect-token': session.reconnectToken, ...hdr(db, owner.id) },
    })
    expect(res.statusCode).toBe(204)
    expect(sessions.get(session.id)).toBeUndefined() // gone
    await app.close()
  })

  it('is an idempotent 204 for an unknown session id (no reconnect token needed)', async () => {
    const { db, users, serverSettings, owner } = setup()
    const { app } = await buildAppWithManager(db, users, serverSettings, fakeOrchestrator())
    const res = await app.inject({ method: 'DELETE', url: '/sessions/does-not-exist', headers: hdr(db, owner.id) })
    expect(res.statusCode).toBe(204)
    await app.close()
  })
})

describe('DELETE /sessions/:id userId ownership (#41)', () => {
  it('rejects a member who does not own the session with 403 and does NOT destroy', async () => {
    const { db, users, serverSettings, member, owner } = setup()
    const { app, sessions } = await buildAppWithManager(db, users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions, owner.id) // owned by someone else
    const res = await app.inject({
      method: 'DELETE', url: `/sessions/${session.id}`,
      headers: { 'x-reconnect-token': session.reconnectToken, ...hdr(db, member.id) },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
    expect(sessions.get(session.id)).toBeDefined() // still alive
    await app.close()
  })

  it('allows the session owner to delete (204)', async () => {
    const { db, users, serverSettings, member } = setup()
    const { app, sessions } = await buildAppWithManager(db, users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions, member.id)
    const res = await app.inject({
      method: 'DELETE', url: `/sessions/${session.id}`,
      headers: { 'x-reconnect-token': session.reconnectToken, ...hdr(db, member.id) },
    })
    expect(res.statusCode).toBe(204)
    expect(sessions.get(session.id)).toBeUndefined()
    await app.close()
  })

  it('allows an admin to delete a session owned by someone else (204)', async () => {
    const { db, users, serverSettings, member, admin } = setup()
    const { app, sessions } = await buildAppWithManager(db, users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions, member.id)
    const res = await app.inject({
      method: 'DELETE', url: `/sessions/${session.id}`,
      headers: { 'x-reconnect-token': session.reconnectToken, ...hdr(db, admin.id) },
    })
    expect(res.statusCode).toBe(204)
    expect(sessions.get(session.id)).toBeUndefined()
    await app.close()
  })

  it('rejects an owned session when unauthenticated (401)', async () => {
    const { db, users, serverSettings, member } = setup()
    const { app, sessions } = await buildAppWithManager(db, users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions, member.id)
    const res = await app.inject({
      method: 'DELETE', url: `/sessions/${session.id}`,
      headers: { 'x-reconnect-token': session.reconnectToken },
    })
    expect(res.statusCode).toBe(401)
    expect(sessions.get(session.id)).toBeDefined()
    await app.close()
  })

  it('allows any authenticated user to delete a headless session (userId unset) with the token', async () => {
    const { db, users, serverSettings, member } = setup()
    const { app, sessions } = await buildAppWithManager(db, users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions) // no userId
    const res = await app.inject({
      method: 'DELETE', url: `/sessions/${session.id}`,
      headers: { 'x-reconnect-token': session.reconnectToken, ...hdr(db, member.id) },
    })
    expect(res.statusCode).toBe(204)
    expect(sessions.get(session.id)).toBeUndefined()
    await app.close()
  })
})

describe('GET /sessions/:id/ws userId ownership (#41)', () => {
  /** Mint a session bearer token for a user id (the WS upgrade carries it via
   *  the hz_session cookie). */
  const tokenFor = (db: DatabaseSync, userId: string) => createSessionRepo(db).issue(userId).token

  it('connects (no 4001) and gets a server frame when the user owns the session', async () => {
    const { db, users, serverSettings, member } = setup()
    const { app, sessions, port } = await buildListeningApp(db, users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions, member.id)
    const result = await connectWs(port, session.id, tokenFor(db, member.id))
    expect(result.rejected).toBe(false)
    expect(result.gotServerFrame).toBe(true) // session-ready sent on attach
    await app.close()
  })

  it('rejects with close 4001 when a member does not own the session', async () => {
    const { db, users, serverSettings, member, owner } = setup()
    const { app, sessions, port } = await buildListeningApp(db, users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions, owner.id)
    const result = await connectWs(port, session.id, tokenFor(db, member.id))
    expect(result.rejected).toBe(true)
    expect(result.code).toBe(4001)
    expect(result.gotServerFrame).toBe(false) // handler never ran the happy path
    await app.close()
  })

  it('allows an admin to attach to any session (no 4001)', async () => {
    const { db, users, serverSettings, member, admin } = setup()
    const { app, sessions, port } = await buildListeningApp(db, users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions, member.id)
    const result = await connectWs(port, session.id, tokenFor(db, admin.id))
    expect(result.rejected).toBe(false)
    expect(result.gotServerFrame).toBe(true)
    await app.close()
  })

  it('allows any authenticated user to attach to a headless (userId unset) session', async () => {
    const { db, users, serverSettings, member } = setup()
    const { app, sessions, port } = await buildListeningApp(db, users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions)
    const result = await connectWs(port, session.id, tokenFor(db, member.id))
    expect(result.rejected).toBe(false)
    expect(result.gotServerFrame).toBe(true)
    await app.close()
  })

  it('rejects the WS upgrade entirely when unauthenticated (auth hook 401)', async () => {
    const { db, users, serverSettings, member } = setup()
    const { app, sessions, port } = await buildListeningApp(db, users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions, member.id)
    const result = await connectWs(port, session.id) // no token
    expect(result.rejected).toBe(true)
    expect(result.authFailed).toBe(true) // upgrade aborted before the route ran
    expect(result.gotServerFrame).toBe(false)
    await app.close()
  })

  // Guard: the WS path is NOT allowlisted, so the global requireAuth hook runs on
  // the upgrade request and rejects a tokenless upgrade before the route handler.
  // inject() can't complete a real WS handshake, but it proves the auth hook
  // short-circuits the upgrade with a non-101 (401) instead of letting it through.
  it('progress WS upgrade without a token is rejected (auth hook, non-101)', async () => {
    const { db, users, serverSettings, member } = setup()
    const orch = fakeOrchestrator()
    const { app, sessions } = await buildAppWithManager(db, users, serverSettings, orch)
    const session = seedSession(sessions, member.id)
    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/ws`,
      headers: { connection: 'upgrade', upgrade: 'websocket' },
    })
    expect(res.statusCode).not.toBe(101)
    expect([400, 401, 426]).toContain(res.statusCode)
    expect(res.json().code).toBe('unauthorized')
  })

  // Browser-playback path: the httpOnly hz_session cookie auto-rides the WS
  // upgrade (the `?user=` query hack is gone). A matching owner cookie connects.
  it('connects (no 4001) when the owner session cookie rides the upgrade (browser path)', async () => {
    const { db, users, serverSettings, member } = setup()
    const { app, sessions, port } = await buildListeningApp(db, users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions, member.id)
    const result = await connectWs(port, session.id, tokenFor(db, member.id), 'cookie')
    expect(result.rejected).toBe(false)
    expect(result.gotServerFrame).toBe(true) // session-ready sent on attach
    await app.close()
  })

  it('rejects via the cookie path when the member does not own the session (close 4001)', async () => {
    const { db, users, serverSettings, member, owner } = setup()
    const { app, sessions, port } = await buildListeningApp(db, users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions, owner.id)
    const result = await connectWs(port, session.id, tokenFor(db, member.id), 'cookie')
    expect(result.rejected).toBe(true)
    expect(result.code).toBe(4001)
    await app.close()
  })
})
