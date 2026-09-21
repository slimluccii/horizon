import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerMetadata, MAX_IMAGE_BYTES } from './metadata.ts'
import { isAllowlisted } from '../../../identity/index.ts'
import type { Config } from '../../../../platform/config/config.ts'

let app: FastifyInstance
let cacheDir: string

function upstream(status: number, body: Uint8Array | null, headers: Record<string, string> = {}) {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(body as BodyInit | null, { status, headers }))
}

const cachedFiles = () =>
  existsSync(cacheDir) ? readdirSync(cacheDir, { recursive: true }).filter(f => /\.(jpg|png)/.test(String(f)) || String(f).includes('.tmp')) : []

beforeEach(async () => {
  cacheDir = mkdtempSync(path.join(os.tmpdir(), 'horizon-img-'))
  app = Fastify({ logger: false })
  registerMetadata(app, { cacheDir } as Config)
  await app.ready()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await app.close()
  rmSync(cacheDir, { recursive: true, force: true })
})

describe('image proxy', () => {
  it('is not reachable without a session, so a stranger cannot fill the data volume', () => {
    expect(isAllowlisted('/metadata/image/w342/abc.jpg', 'GET')).toBe(false)
  })

  it('serves an image and lets the browser cache it for a long time', async () => {
    vi.stubGlobal('fetch', upstream(200, new Uint8Array([1, 2, 3]), { 'content-length': '3' }))
    const res = await app.inject({ method: 'GET', url: '/metadata/image/w342/abc.jpg' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toContain('immutable')
    expect(res.rawPayload.length).toBe(3)
  })

  it('does not let the browser cache a failure', async () => {
    vi.stubGlobal('fetch', upstream(404, null))
    const missing = await app.inject({ method: 'GET', url: '/metadata/image/w342/gone.jpg' })
    expect(missing.statusCode).toBe(404)
    expect(missing.headers['cache-control']).toBe('no-store')

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const failed = await app.inject({ method: 'GET', url: '/metadata/image/w342/down.jpg' })
    expect(failed.statusCode).toBe(500)
    expect(failed.headers['cache-control']).toBe('no-store')
  })

  it('refuses an image that announces itself as too large, and caches nothing', async () => {
    vi.stubGlobal('fetch', upstream(200, new Uint8Array([1]), { 'content-length': String(MAX_IMAGE_BYTES + 1) }))
    const res = await app.inject({ method: 'GET', url: '/metadata/image/original/huge.jpg' })
    expect(res.statusCode).toBe(502)
    expect(res.headers['cache-control']).toBe('no-store')
    await new Promise(r => setTimeout(r, 50))
    expect(cachedFiles()).toEqual([])
  })

  it('keeps an oversized image out of the cache even when the upstream did not announce its size', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', upstream(200, new Uint8Array(MAX_IMAGE_BYTES + 1)))
    await app.inject({ method: 'GET', url: '/metadata/image/original/unannounced.jpg' })
    // The cache write gives up in the background; only then is "nothing cached" meaningful.
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('Image cache write failed')), { timeout: 5000 })
    expect(cachedFiles()).toEqual([])
    warn.mockRestore()
  })

  it('gives the upstream request a deadline', async () => {
    const fetchMock = upstream(200, new Uint8Array([1]), { 'content-length': '1' })
    vi.stubGlobal('fetch', fetchMock)
    await app.inject({ method: 'GET', url: '/metadata/image/w342/abc.jpg' })
    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })
})
