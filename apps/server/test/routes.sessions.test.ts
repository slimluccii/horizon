import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
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

function seedSession(sessions: ReturnType<typeof createSessionManager>) {
  return sessions.create({
    mediaId: 'm1',
    filePath: '/tmp/x.mkv',
    plan: { method: 'direct-play', renditions: [] },
    selectedSubtitleTrack: null,
    audioTrackCount: 1,
    subtitleTrackCount: 0,
    renditionCodecs: [],
    sessionDir: '/tmp/sess-del',
    sessionReady: true,
    durationSec: 100,
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
