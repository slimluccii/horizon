import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase } from '../../../../platform/db/connection.ts'
import { migrate } from '../../../../platform/db/migrations.ts'
import { makeRequireAuth, type UserRepo, type SessionRepo } from '../../../identity/index.ts'
import { createWebhookKeyRepo, type WebhookKeyRepo } from '../persistence/webhookKey.ts'
import { registerArrWebhook } from './arrWebhook.ts'

type Role = 'owner' | 'admin' | 'member'
const roles: Record<string, Role> = { owner1: 'owner', admin1: 'admin', member1: 'member' }
const users = { get: (id: string) => (roles[id] ? { id, role: roles[id] } : undefined) } as unknown as UserRepo
const sessions = {
  resolve: (token: string) => (roles[token]
    ? { id: `sess-${token}`, userId: token, createdAt: 0, expiresAt: Date.now() + 1e6, lastSeenAt: 0, userAgent: null }
    : null),
} as unknown as SessionRepo
const tok = (id: string) => ({ authorization: `Bearer ${id}` })

describe('arr webhook', () => {
  let app: FastifyInstance
  let keys: WebhookKeyRepo
  let root: string
  let requested: { trigger: string; paths: string[] }[]
  let libraryFolders: string[]

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'horizon-arr-'))
    const db = openDatabase(':memory:')
    migrate(db)
    keys = createWebhookKeyRepo(db)
    requested = []
    libraryFolders = []
    app = Fastify()
    app.addHook('onRequest', makeRequireAuth(sessions, users))
    registerArrWebhook(app, {
      keys,
      users,
      getRoots: () => ({ movies: [path.join(root, 'movies')], shows: [path.join(root, 'tv')] }),
      hasItemsUnder: folder => libraryFolders.includes(folder),
      requestScan: async req => { requested.push(req) },
    })
  })

  afterEach(async () => {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  })

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/webhooks/arr', payload: body as object, headers })

  describe('key', () => {
    it('lets the owner or an admin generate a key, shown once', async () => {
      const res = await app.inject({ method: 'POST', url: '/webhooks/arr/key', headers: tok('owner1') })
      expect(res.statusCode).toBe(201)
      expect(res.json().key).toMatch(/^[A-Za-z0-9_-]{32,}$/)
      expect((await app.inject({ method: 'POST', url: '/webhooks/arr/key', headers: tok('admin1') })).statusCode).toBe(201)
    })

    it('refuses members and anonymous callers', async () => {
      expect((await app.inject({ method: 'POST', url: '/webhooks/arr/key', headers: tok('member1') })).statusCode).toBe(403)
      expect((await app.inject({ method: 'POST', url: '/webhooks/arr/key' })).statusCode).toBe(401)
    })

    it('replaces the previous key when a new one is generated', async () => {
      const first = keys.rotate()
      const second = keys.rotate()
      expect(keys.matches(first)).toBe(false)
      expect(keys.matches(second)).toBe(true)
    })

    it('matches nothing before a key exists', () => {
      expect(keys.matches('')).toBe(false)
      expect(keys.matches('anything')).toBe(false)
    })
  })

  describe('events', () => {
    const movieFolder = () => path.join(root, 'movies', 'Dune (2021)')
    const download = { eventType: 'Download', movie: { folderPath: '/data/media/movies/Dune (2021)' } }

    it('rejects a request without a valid key', async () => {
      keys.rotate()
      expect((await post(download)).statusCode).toBe(401)
      expect((await post(download, { 'x-api-key': 'wrong' })).statusCode).toBe(401)
      expect(requested).toEqual([])
    })

    it('rejects every request while no key has been generated', async () => {
      expect((await post(download, { 'x-api-key': '' })).statusCode).toBe(401)
    })

    it('queues a subtree scan of the folder as the library sees it', async () => {
      mkdirSync(movieFolder(), { recursive: true })
      const res = await post(download, { 'x-api-key': keys.rotate() })
      expect(res.statusCode).toBe(202)
      expect(res.json()).toEqual({ paths: [movieFolder()] })
      expect(requested).toEqual([{ trigger: 'webhook', paths: [movieFolder()] }])
    })

    it('still scans a folder arr already deleted, so its items get removed', async () => {
      libraryFolders = [movieFolder()]
      const res = await post(
        { eventType: 'MovieDelete', movie: { folderPath: '/data/media/movies/Dune (2021)' } },
        { 'x-api-key': keys.rotate() },
      )
      expect(res.statusCode).toBe(202)
      expect(requested).toEqual([{ trigger: 'webhook', paths: [movieFolder()] }])
    })

    it('resolves a series only against the shows roots', async () => {
      mkdirSync(path.join(root, 'movies', 'Frieren'), { recursive: true })
      mkdirSync(path.join(root, 'tv', 'anime', 'Frieren'), { recursive: true })
      const res = await post(
        { eventType: 'Download', series: { path: '/data/tv/anime/Frieren' } },
        { 'x-api-key': keys.rotate() },
      )
      expect(res.json()).toEqual({ paths: [path.join(root, 'tv', 'anime', 'Frieren')] })
    })

    it('answers 200 for the test button and other events that change nothing', async () => {
      const res = await post({ eventType: 'Test', movie: { folderPath: '/data/media/movies/x' } }, { 'x-api-key': keys.rotate() })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ignored: true })
      expect(requested).toEqual([])
    })

    it('answers 200 with no paths when no root knows the folder, so arr does not flag the connection', async () => {
      const res = await post(download, { 'x-api-key': keys.rotate() })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ paths: [] })
      expect(requested).toEqual([])
    })
  })
})
