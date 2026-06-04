import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTmdbProvider } from '../src/metadata/tmdb.ts'

// These tests exercise the per-request timeout added in #50. We stub the global
// `fetch` so no real network is touched. Rather than wait the full 30s, we
// simulate the two terminal states: an AbortError (what the AbortController
// raises on timeout) and a plain network error, and assert the provider
// resolves to null and logs them distinctly.

let cacheDir: string
const realFetch = globalThis.fetch

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'tmdb-test-'))
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
  rmSync(cacheDir, { recursive: true, force: true })
})

function abortError(): Error {
  const err = new Error('The operation was aborted')
  err.name = 'AbortError'
  return err
}

describe('TmdbProvider fetch timeout (#50)', () => {
  it('wires an AbortSignal into every fetch (so a timeout can cancel it)', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => {
      throw abortError()
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const provider = createTmdbProvider('token', cacheDir)!
    expect(provider).not.toBeNull()
    await provider.movieByTmdbId(123)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('a timed-out (aborted) request resolves to null and does not hang', async () => {
    const fetchSpy = vi.fn(async () => { throw abortError() })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const provider = createTmdbProvider('token', cacheDir)!
    const result = await provider.movieByTmdbId(123)
    expect(result).toBeNull()
  })

  it('logs a timeout distinctly from a network error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchSpy = vi.fn(async () => { throw abortError() })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const provider = createTmdbProvider('token', cacheDir)!
    await provider.movieByTmdbId(456)

    const timeoutLogged = warnSpy.mock.calls.some(c => String(c[0]).includes('TMDB timeout'))
    const networkLogged = warnSpy.mock.calls.some(c => String(c[0]).includes('TMDB network error'))
    expect(timeoutLogged).toBe(true)
    expect(networkLogged).toBe(false)
  })

  it('logs a non-timeout failure as a network error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchSpy = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const provider = createTmdbProvider('token', cacheDir)!
    const result = await provider.movieByTmdbId(789)
    expect(result).toBeNull()
    const networkLogged = warnSpy.mock.calls.some(c => String(c[0]).includes('TMDB network error'))
    expect(networkLogged).toBe(true)
  })
})

describe('TmdbProvider mapMovie collection', () => {
  it('maps belongs_to_collection into MovieMetadata.collection', async () => {
    const payload = {
      id: 671,
      title: 'Harry Potter',
      belongs_to_collection: {
        id: 1241,
        name: 'Harry Potter Collection',
        poster_path: '/p.jpg',
        backdrop_path: '/b.jpg',
      },
    }
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const provider = createTmdbProvider('token', cacheDir)!
    const meta = await provider.movieByTmdbId(671)
    expect(meta?.collection).toEqual({
      tmdbId: 1241,
      name: 'Harry Potter Collection',
      posterPath: '/p.jpg',
      backdropPath: '/b.jpg',
    })
  })
})
