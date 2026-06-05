import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import { openDatabase } from '../db/connection.ts'
import { migrate } from '../db/migrations.ts'
import { createMediaRepo, createCollectionsRepo } from '../../contexts/library/index.ts'
import { registerDev } from './dev.ts'

async function buildApp() {
  const db = openDatabase(':memory:')
  migrate(db)
  const media = createMediaRepo(db)
  const collections = createCollectionsRepo(db)
  const app = Fastify({ logger: false })
  registerDev(app, { media, collections, db })
  await app.ready()
  return app
}

let app: Awaited<ReturnType<typeof buildApp>> | undefined
afterEach(async () => { if (app) { await app.close(); app = undefined } })

describe('GET /dev/seed (not rate-limited)', () => {
  it('lists scenarios on repeated calls without limiting', async () => {
    app = await buildApp()
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/dev/seed' })
      expect(res.statusCode).toBe(200)
      expect(res.json().scenarios).toContain('empty')
    }
  })
})

describe('POST /dev/seed/:scenario rate limiting (#88)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('succeeds on the first call', async () => {
    app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/dev/seed/empty' })
    expect(res.statusCode).toBe(200)
    expect(res.json().scenario).toBe('empty')
  })

  it('returns 429 rate-limited on the second call within the 5-minute window', async () => {
    app = await buildApp()
    const first = await app.inject({ method: 'POST', url: '/dev/seed/empty' })
    expect(first.statusCode).toBe(200)
    const second = await app.inject({ method: 'POST', url: '/dev/seed/empty' })
    expect(second.statusCode).toBe(429)
    expect(second.json().code).toBe('rate-limited')
  })

  it('succeeds again after the 5-minute window resets', async () => {
    app = await buildApp()
    expect((await app.inject({ method: 'POST', url: '/dev/seed/empty' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/dev/seed/empty' })).statusCode).toBe(429)
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    expect((await app.inject({ method: 'POST', url: '/dev/seed/empty' })).statusCode).toBe(200)
  })
})
