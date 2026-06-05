import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerLibrary, sseFrame, type MediaRepo, type CollectionsRepo } from '../src/contexts/library/index.ts'
import { makeRequireAuth } from '../src/contexts/identity/index.ts'
import type { Config } from '../src/platform/config/config.ts'
import type { UserRepo } from '../src/contexts/identity/index.ts'
import type { SessionRepo } from '../src/contexts/identity/index.ts'
import type { ScanWorkers } from '../src/platform/http/server.ts'

type Role = 'owner' | 'admin' | 'member'

function fakeUsers(byId: Record<string, Role>): UserRepo {
  return {
    get: (id: string) => (byId[id] ? { id, role: byId[id] } : undefined),
  } as unknown as UserRepo
}

function fakeSessions(byId: Record<string, Role>): SessionRepo {
  return {
    resolve: (token: string) => (byId[token]
      ? { id: `sess-${token}`, userId: token, createdAt: 0, expiresAt: Date.now() + 1e6, lastSeenAt: 0, userAgent: null }
      : null),
  } as unknown as SessionRepo
}

const tok = (id: string) => ({ authorization: `Bearer ${id}` })

const noopCfg = {} as Config

const fakeWorkers = {
  activityBus: {
    recent: () => [{ seq: 0, ts: 1, kind: 'meta:start', message: 'x' }],
    subscribe: () => () => {},
    emit: () => {},
  },
} as unknown as ScanWorkers

const fakeMedia = {} as unknown as MediaRepo
const fakeCollections = {} as unknown as CollectionsRepo

describe('GET /library/activity/stream', () => {
  let app: FastifyInstance
  const roles: Record<string, Role> = { owner1: 'owner', member1: 'member' }
  const users = fakeUsers(roles)
  const sessions = fakeSessions(roles)

  beforeEach(() => {
    app = Fastify()
    app.addHook('onRequest', makeRequireAuth(sessions, users))
    registerLibrary(app, fakeMedia, fakeCollections, fakeWorkers, users, noopCfg)
  })

  afterEach(async () => {
    await app.close()
  })

  it('sseFrame serializes an event', () => {
    expect(sseFrame({ seq: 1, ts: 2, kind: 'meta:start', message: 'x' } as never)).toBe('data: {"seq":1,"ts":2,"kind":"meta:start","message":"x"}\n\n')
  })

  it('rejects members', async () => {
    const res = await app.inject({ method: 'GET', url: '/library/activity/stream', headers: tok('member1') })
    expect(res.statusCode).toBe(403)
  })

  it('rejects unauthenticated requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/library/activity/stream' })
    expect(res.statusCode).toBe(401)
  })

  it('rejects an unknown/invalid session token', async () => {
    const res = await app.inject({ method: 'GET', url: '/library/activity/stream', headers: tok('ghost') })
    expect(res.statusCode).toBe(401)
  })
})
