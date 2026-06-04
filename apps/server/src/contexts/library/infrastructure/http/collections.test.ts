import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerLibrary } from './library.ts'
import { makeRequireAuth } from '../../../identity/index.ts'
import type { Config } from '../../../../platform/config/config.ts'
import type { MediaRepo } from '../persistence/media.ts'
import type { Collection, CollectionsRepo } from '../persistence/collections.ts'
import type { UserRepo } from '../../../identity/index.ts'
import type { SessionRepo } from '../../../identity/index.ts'
import type { ScanWorkers } from '../../../../platform/http/server.ts'

type Role = 'owner' | 'admin' | 'member'

function fakeUsers(byId: Record<string, Role>): UserRepo {
  return {
    get: (id: string) => (byId[id] ? { id, role: byId[id] } : undefined),
  } as unknown as UserRepo
}

// The bearer token IS the user id.
function fakeSessions(byId: Record<string, Role>): SessionRepo {
  return {
    resolve: (token: string) => (byId[token]
      ? { id: `sess-${token}`, userId: token, createdAt: 0, expiresAt: Date.now() + 1e6, lastSeenAt: 0, userAgent: null }
      : null),
  } as unknown as SessionRepo
}

const tok = (id: string) => ({ authorization: `Bearer ${id}` })

const noopWorkers = {} as ScanWorkers
const noopCfg = {} as Config

function fakeMedia(byId: Record<string, { id: string }>): MediaRepo {
  return {
    getById: (id: string) => byId[id],
  } as unknown as MediaRepo
}

function fakeCollections(cols: Collection[]): CollectionsRepo {
  return {
    list: () => cols,
    replaceAll: () => {},
  } as unknown as CollectionsRepo
}

describe('GET /library/movies/collections', () => {
  let app: FastifyInstance
  const roles: Record<string, Role> = { owner1: 'owner' }
  const users = fakeUsers(roles)
  const sessions = fakeSessions(roles)
  const media = fakeMedia({
    m1: { id: 'm1' },
    m2: { id: 'm2' },
  })
  const collections = fakeCollections([
    {
      id: 'c1',
      name: 'Harry Potter Collection',
      tmdbId: 1241,
      posterPath: '/p.jpg',
      backdropPath: '/b.jpg',
      movieIds: ['m1', 'm2'],
    },
  ])

  beforeEach(() => {
    app = Fastify()
    app.addHook('onRequest', makeRequireAuth(sessions, users))
    registerLibrary(app, media, collections, noopWorkers, users, noopCfg)
  })

  afterEach(async () => {
    await app.close()
  })

  it('returns posterPath/backdropPath/tmdbId per collection', async () => {
    const res = await app.inject({ method: 'GET', url: '/library/movies/collections', headers: tok('owner1') })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body[0]).toMatchObject({ id: 'c1', name: 'Harry Potter Collection', tmdbId: 1241, posterPath: '/p.jpg', backdropPath: '/b.jpg' })
    expect(body[0].movies).toHaveLength(2)
  })
})
