import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import fastifyWebSocket from '@fastify/websocket'
import { WebSocket } from 'ws'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createUserRepo } from '../src/repos/users.ts'
import { createServerSettings } from '../src/repos/serverSettings.ts'
import { createSessionManager } from '../src/session/manager.ts'
import { registerSessions } from '../src/routes/sessions.ts'
import type { HwAccel } from '../src/transcode/hwaccel.ts'
import type { ProgressRepo } from '../src/repos/progress.ts'
import type { Config } from '../src/config.ts'
import type {
  PlaybackOrchestrator,
  StartPlaybackInput,
  StartPlaybackResult,
} from '../src/session/playback.ts'

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
  users: ReturnType<typeof setup>['users'],
  serverSettings: ReturnType<typeof setup>['serverSettings'],
  orchestrator: PlaybackOrchestrator,
) {
  const app = Fastify({ logger: false })
  const sessions = createSessionManager(serverSettings)
  const progressRepo = {} as ProgressRepo
  const cfg = {} as Config
  registerSessions(app, cfg, hwAccel, sessions, progressRepo, orchestrator, serverSettings, users)
  await app.ready()
  return app
}

/** Builds an app and exposes the live SessionManager so DELETE tests can seed a
 *  real session (the fakeOrchestrator never registers one with the manager). */
async function buildAppWithManager(
  users: ReturnType<typeof setup>['users'],
  serverSettings: ReturnType<typeof setup>['serverSettings'],
  orchestrator: PlaybackOrchestrator,
) {
  const app = Fastify({ logger: false })
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
  users: ReturnType<typeof setup>['users'],
  serverSettings: ReturnType<typeof setup>['serverSettings'],
  orchestrator: PlaybackOrchestrator,
) {
  const app = Fastify({ logger: false })
  await app.register(fastifyWebSocket)
  const sessions = createSessionManager(serverSettings)
  const progressRepo = { flush() {}, get() { return undefined } } as unknown as ProgressRepo
  const cfg = {} as Config
  registerSessions(app, cfg, hwAccel, sessions, progressRepo, orchestrator, serverSettings, users)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { app, sessions, port }
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
  userId?: string,
  // Browser WebSocket upgrades cannot set request headers, so real clients pass
  // the caller id as a `user` query param instead. `via` selects which path to
  // exercise: 'header' (the Node-client default) or 'query' (the browser path).
  via: 'header' | 'query' = 'header',
): Promise<{ rejected: boolean; code?: number; gotServerFrame: boolean }> {
  return new Promise((resolve) => {
    const headers = userId && via === 'header' ? { 'x-horizon-user': userId } : undefined
    const query = userId && via === 'query' ? `?user=${encodeURIComponent(userId)}` : ''
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sessions/${sessionId}/ws${query}`, { headers })
    let gotServerFrame = false
    // For the allowed path the handler keeps the socket open; close it from the
    // client after a tick so the promise resolves with a non-4001 code.
    ws.on('open', () => setTimeout(() => ws.close(), 50))
    ws.on('message', () => { gotServerFrame = true })
    ws.on('close', (code) => resolve({ rejected: code === 4001, code, gotServerFrame }))
    ws.on('error', () => { /* a close event with the code follows */ })
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
  it('returns 400 no-user when X-Horizon-User header is absent', async () => {
    const { users, serverSettings } = setup()
    const orch = fakeOrchestrator()
    const app = await buildApp(users, serverSettings, orch)
    const res = await app.inject({ method: 'POST', url: '/sessions', payload: body() })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('no-user')
    expect(orch.calls).toHaveLength(0)
  })

  it('returns 400 no-user when header is an unknown user', async () => {
    const { users, serverSettings } = setup()
    const orch = fakeOrchestrator()
    const app = await buildApp(users, serverSettings, orch)
    const res = await app.inject({
      method: 'POST', url: '/sessions', payload: body(),
      headers: { 'x-horizon-user': 'ghost' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('no-user')
  })

  it('succeeds with valid header and no userId in body, defaulting userId to caller', async () => {
    const { users, serverSettings, member } = setup()
    const orch = fakeOrchestrator()
    const app = await buildApp(users, serverSettings, orch)
    const res = await app.inject({
      method: 'POST', url: '/sessions', payload: body(),
      headers: { 'x-horizon-user': member.id },
    })
    expect(res.statusCode).toBe(200)
    expect(orch.calls[0].userId).toBe(member.id)
  })

  it('succeeds when userId matches the caller', async () => {
    const { users, serverSettings, member } = setup()
    const orch = fakeOrchestrator()
    const app = await buildApp(users, serverSettings, orch)
    const res = await app.inject({
      method: 'POST', url: '/sessions', payload: body({ userId: member.id }),
      headers: { 'x-horizon-user': member.id },
    })
    expect(res.statusCode).toBe(200)
    expect(orch.calls[0].userId).toBe(member.id)
  })

  it('returns 403 caller-forbidden when a member delegates to another user', async () => {
    const { users, serverSettings, member, owner } = setup()
    const orch = fakeOrchestrator()
    const app = await buildApp(users, serverSettings, orch)
    const res = await app.inject({
      method: 'POST', url: '/sessions', payload: body({ userId: owner.id }),
      headers: { 'x-horizon-user': member.id },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
    expect(orch.calls).toHaveLength(0)
  })

  it('allows owner/admin to delegate playback for another user', async () => {
    const { users, serverSettings, admin, member } = setup()
    const orch = fakeOrchestrator()
    const app = await buildApp(users, serverSettings, orch)
    const res = await app.inject({
      method: 'POST', url: '/sessions', payload: body({ userId: member.id }),
      headers: { 'x-horizon-user': admin.id },
    })
    expect(res.statusCode).toBe(200)
    expect(orch.calls[0].userId).toBe(member.id)
  })

  it('returns 400 invalid-input for a negative audioTrackIndex (Zod)', async () => {
    const { users, serverSettings, member } = setup()
    const orch = fakeOrchestrator()
    const app = await buildApp(users, serverSettings, orch)
    const res = await app.inject({
      method: 'POST', url: '/sessions', payload: body({ audioTrackIndex: -1 }),
      headers: { 'x-horizon-user': member.id },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
    expect(orch.calls).toHaveLength(0)
  })

  it('returns 400 invalid-input for a non-integer startPositionMs (Zod)', async () => {
    const { users, serverSettings, member } = setup()
    const orch = fakeOrchestrator()
    const app = await buildApp(users, serverSettings, orch)
    const res = await app.inject({
      method: 'POST', url: '/sessions', payload: body({ startPositionMs: 1.5 }),
      headers: { 'x-horizon-user': member.id },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('returns 400 invalid-input for unknown keys (.strict)', async () => {
    const { users, serverSettings, member } = setup()
    const orch = fakeOrchestrator()
    const app = await buildApp(users, serverSettings, orch)
    const res = await app.inject({
      method: 'POST', url: '/sessions', payload: body({ bogus: true }),
      headers: { 'x-horizon-user': member.id },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('maps invalid-input from the orchestrator to HTTP 400', async () => {
    const { users, serverSettings, member } = setup()
    const orch: PlaybackOrchestrator = {
      startPlayback() {
        throw Object.assign(new Error('Start position exceeds media duration'), { code: 'invalid-input' })
      },
    }
    const app = await buildApp(users, serverSettings, orch)
    const res = await app.inject({
      method: 'POST', url: '/sessions', payload: body({ startPositionMs: 999 }),
      headers: { 'x-horizon-user': member.id },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('maps audio-track-invalid from the orchestrator to HTTP 400', async () => {
    const { users, serverSettings, member } = setup()
    const orch: PlaybackOrchestrator = {
      startPlayback() {
        throw Object.assign(new Error('Audio track index out of bounds'), { code: 'audio-track-invalid' })
      },
    }
    const app = await buildApp(users, serverSettings, orch)
    const res = await app.inject({
      method: 'POST', url: '/sessions', payload: body({ audioTrackIndex: 99 }),
      headers: { 'x-horizon-user': member.id },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('audio-track-invalid')
  })
})

describe('DELETE /sessions/:id reconnect token (#41)', () => {
  it('rejects a DELETE without the reconnect token with 400 and does NOT destroy', async () => {
    const { users, serverSettings } = setup()
    const { app, sessions } = await buildAppWithManager(users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions)
    const res = await app.inject({ method: 'DELETE', url: `/sessions/${session.id}` })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-reconnect-token')
    expect(sessions.get(session.id)).toBeDefined() // still alive
    await app.close()
  })

  it('rejects a DELETE with a mismatched token with 400 and does NOT destroy', async () => {
    const { users, serverSettings } = setup()
    const { app, sessions } = await buildAppWithManager(users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions)
    const res = await app.inject({
      method: 'DELETE', url: `/sessions/${session.id}`,
      headers: { 'x-reconnect-token': 'wrong-token' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-reconnect-token')
    expect(sessions.get(session.id)).toBeDefined()
    await app.close()
  })

  it('destroys the session with the correct token (204)', async () => {
    const { users, serverSettings } = setup()
    const { app, sessions } = await buildAppWithManager(users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions)
    const res = await app.inject({
      method: 'DELETE', url: `/sessions/${session.id}`,
      headers: { 'x-reconnect-token': session.reconnectToken },
    })
    expect(res.statusCode).toBe(204)
    expect(sessions.get(session.id)).toBeUndefined() // gone
    await app.close()
  })

  it('is an idempotent 204 for an unknown session id (no token needed)', async () => {
    const { users, serverSettings } = setup()
    const { app } = await buildAppWithManager(users, serverSettings, fakeOrchestrator())
    const res = await app.inject({ method: 'DELETE', url: '/sessions/does-not-exist' })
    expect(res.statusCode).toBe(204)
    await app.close()
  })
})

describe('DELETE /sessions/:id userId ownership (#41)', () => {
  it('rejects a member who does not own the session with 403 and does NOT destroy', async () => {
    const { users, serverSettings, member, owner } = setup()
    const { app, sessions } = await buildAppWithManager(users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions, owner.id) // owned by someone else
    const res = await app.inject({
      method: 'DELETE', url: `/sessions/${session.id}`,
      headers: { 'x-reconnect-token': session.reconnectToken, 'x-horizon-user': member.id },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
    expect(sessions.get(session.id)).toBeDefined() // still alive
    await app.close()
  })

  it('allows the session owner to delete (204)', async () => {
    const { users, serverSettings, member } = setup()
    const { app, sessions } = await buildAppWithManager(users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions, member.id)
    const res = await app.inject({
      method: 'DELETE', url: `/sessions/${session.id}`,
      headers: { 'x-reconnect-token': session.reconnectToken, 'x-horizon-user': member.id },
    })
    expect(res.statusCode).toBe(204)
    expect(sessions.get(session.id)).toBeUndefined()
    await app.close()
  })

  it('allows an admin to delete a session owned by someone else (204)', async () => {
    const { users, serverSettings, member, admin } = setup()
    const { app, sessions } = await buildAppWithManager(users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions, member.id)
    const res = await app.inject({
      method: 'DELETE', url: `/sessions/${session.id}`,
      headers: { 'x-reconnect-token': session.reconnectToken, 'x-horizon-user': admin.id },
    })
    expect(res.statusCode).toBe(204)
    expect(sessions.get(session.id)).toBeUndefined()
    await app.close()
  })

  it('rejects an owned session when no user header is present (403)', async () => {
    const { users, serverSettings, member } = setup()
    const { app, sessions } = await buildAppWithManager(users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions, member.id)
    const res = await app.inject({
      method: 'DELETE', url: `/sessions/${session.id}`,
      headers: { 'x-reconnect-token': session.reconnectToken },
    })
    expect(res.statusCode).toBe(403)
    expect(sessions.get(session.id)).toBeDefined()
    await app.close()
  })

  it('allows deleting a headless session (userId unset) with just the token', async () => {
    const { users, serverSettings } = setup()
    const { app, sessions } = await buildAppWithManager(users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions) // no userId
    const res = await app.inject({
      method: 'DELETE', url: `/sessions/${session.id}`,
      headers: { 'x-reconnect-token': session.reconnectToken },
    })
    expect(res.statusCode).toBe(204)
    expect(sessions.get(session.id)).toBeUndefined()
    await app.close()
  })
})

describe('GET /sessions/:id/ws userId ownership (#41)', () => {
  it('connects (no 4001) and gets a server frame when the user owns the session', async () => {
    const { users, serverSettings, member } = setup()
    const { app, sessions, port } = await buildListeningApp(users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions, member.id)
    const result = await connectWs(port, session.id, member.id)
    expect(result.rejected).toBe(false)
    expect(result.gotServerFrame).toBe(true) // session-ready sent on attach
    await app.close()
  })

  it('rejects with close 4001 when a member does not own the session', async () => {
    const { users, serverSettings, member, owner } = setup()
    const { app, sessions, port } = await buildListeningApp(users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions, owner.id)
    const result = await connectWs(port, session.id, member.id)
    expect(result.rejected).toBe(true)
    expect(result.code).toBe(4001)
    expect(result.gotServerFrame).toBe(false) // handler never ran the happy path
    await app.close()
  })

  it('allows an admin to attach to any session (no 4001)', async () => {
    const { users, serverSettings, member, admin } = setup()
    const { app, sessions, port } = await buildListeningApp(users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions, member.id)
    const result = await connectWs(port, session.id, admin.id)
    expect(result.rejected).toBe(false)
    expect(result.gotServerFrame).toBe(true)
    await app.close()
  })

  it('allows attaching to a headless (userId unset) session with no user header', async () => {
    const { users, serverSettings } = setup()
    const { app, sessions, port } = await buildListeningApp(users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions)
    const result = await connectWs(port, session.id)
    expect(result.rejected).toBe(false)
    expect(result.gotServerFrame).toBe(true)
    await app.close()
  })

  it('rejects an owned session when no user header is present (close 4001)', async () => {
    const { users, serverSettings, member } = setup()
    const { app, sessions, port } = await buildListeningApp(users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions, member.id)
    const result = await connectWs(port, session.id)
    expect(result.rejected).toBe(true)
    expect(result.code).toBe(4001)
    await app.close()
  })

  // Regression for the browser-playback path: a real browser WebSocket cannot
  // set the X-Horizon-User header, so the owner's identity arrives as a `user`
  // query param. Before resolveCallerRole grew its query fallback this closed
  // with 4001 and the SDK reconnect-looped forever on "STARTING PLAYBACK…".
  it('connects (no 4001) when the owner id is supplied via the user query param (browser path)', async () => {
    const { users, serverSettings, member } = setup()
    const { app, sessions, port } = await buildListeningApp(users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions, member.id)
    const result = await connectWs(port, session.id, member.id, 'query')
    expect(result.rejected).toBe(false)
    expect(result.gotServerFrame).toBe(true) // session-ready sent on attach
    await app.close()
  })

  it('rejects via the user query param when the member does not own the session (close 4001)', async () => {
    const { users, serverSettings, member, owner } = setup()
    const { app, sessions, port } = await buildListeningApp(users, serverSettings, fakeOrchestrator())
    const session = seedSession(sessions, owner.id)
    const result = await connectWs(port, session.id, member.id, 'query')
    expect(result.rejected).toBe(true)
    expect(result.code).toBe(4001)
    await app.close()
  })
})
