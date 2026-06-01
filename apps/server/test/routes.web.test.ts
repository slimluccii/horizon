import { describe, it, expect } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerWeb } from '../src/routes/web.ts'

function makeWebDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'horizon-web-'))
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Horizon</title><div id=root></div>')
  mkdirSync(path.join(dir, 'assets'))
  writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("horizon")')
  return dir
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  // Representative API routes registered BEFORE the web fallback, as in buildServer.
  app.get('/library/movies', async () => [{ id: 'm1' }])
  app.get('/settings/server', async () => ({ ok: true }))
  await registerWeb(app, makeWebDir())
  await app.ready()
  return app
}

describe('web UI serving', () => {
  it('serves index.html at /', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('Horizon')
  })

  it('serves static assets', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('console.log')
  })

  it('falls back to the SPA shell for client-side routes', async () => {
    const app = await buildApp()
    for (const url of ['/settings', '/profiles', '/setup', '/show/abc', '/play/xyz123', '/anything/deep/link']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(200)
      expect(res.headers['content-type'], url).toContain('text/html')
      expect(res.body, url).toContain('id=root')
    }
  })

  it('still serves real API routes (not shadowed by the fallback)', async () => {
    const app = await buildApp()
    const movies = await app.inject({ method: 'GET', url: '/library/movies' })
    expect(movies.statusCode).toBe(200)
    expect(movies.json()).toEqual([{ id: 'm1' }])
    const settings = await app.inject({ method: 'GET', url: '/settings/server' })
    expect(settings.statusCode).toBe(200)
    expect(settings.json()).toEqual({ ok: true })
  })

  it('returns JSON 404 (not the SPA) for unknown API paths', async () => {
    const app = await buildApp()
    for (const url of ['/library/nope', '/users/ghost', '/metadata/x/y', '/settings/server/bogus']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(404)
      expect(res.headers['content-type'], url).toContain('application/json')
      expect(res.json().code, url).toBe('not-found')
    }
  })

  it('returns JSON 404 for non-GET unmatched requests', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/whatever' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.json().code).toBe('not-found')
  })
})
