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
})
