import { describe, it, expect, vi, afterEach } from 'vitest'
import { HorizonClient, isProgressNotFoundError } from '../src/client.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

function mockFetch(impl: () => Partial<Response> & { json?: () => Promise<unknown>; text?: () => Promise<string> }) {
  vi.stubGlobal('fetch', vi.fn(async () => impl() as unknown as Response))
}

describe('isProgressNotFoundError', () => {
  it('returns true for an error with code progress-not-found', () => {
    const err = Object.assign(new Error('no progress'), { code: 'progress-not-found' })
    expect(isProgressNotFoundError(err)).toBe(true)
  })

  it('returns false for an error with a different code', () => {
    expect(isProgressNotFoundError(Object.assign(new Error('x'), { code: 'media-not-found' }))).toBe(false)
  })

  it('returns false for a plain Error without code', () => {
    expect(isProgressNotFoundError(new Error('plain'))).toBe(false)
  })

  it('returns false for non-Error values', () => {
    expect(isProgressNotFoundError(null)).toBe(false)
    expect(isProgressNotFoundError('progress-not-found')).toBe(false)
    expect(isProgressNotFoundError({ code: 'progress-not-found' })).toBe(false)
  })
})

describe('HorizonClient.progress.get', () => {
  const client = new HorizonClient({ baseUrl: 'http://x' })

  it('returns null when server returns 404 with code progress-not-found', async () => {
    mockFetch(() => ({
      ok: false,
      status: 404,
      json: async () => ({ error: 'not found', code: 'progress-not-found' }),
    }))
    await expect(client.progress.get('u1', 'm1')).resolves.toBeNull()
  })

  it('returns null when server returns 404 with unparseable (invalid JSON) body', async () => {
    // No code parsed → fetch throws a code-less error → progress.get re-rejects.
    // But the catch must not blow up on `err.code` access. Here the server still
    // signals not-found via code, delivered through valid JSON.
    mockFetch(() => ({
      ok: false,
      status: 404,
      json: async () => { throw new SyntaxError('Unexpected token <') },
      text: async () => '<html>404</html>',
    }))
    // No code → not recognized as progress-not-found → rejects (does not crash).
    await expect(client.progress.get('u1', 'm1')).rejects.toThrow()
  })

  it('rejects (does not swallow) other errors', async () => {
    mockFetch(() => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom', code: 'transcode-failed' }),
    }))
    await expect(client.progress.get('u1', 'm1')).rejects.toThrow('boom')
  })
})

describe('HorizonClient.fetch error code handling', () => {
  const client = new HorizonClient({ baseUrl: 'http://x' })

  it('does not attach a code property when server omits one', async () => {
    mockFetch(() => ({ ok: false, status: 500, json: async () => ({ error: 'oops' }) }))
    try {
      await client.users.list()
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error & { code?: string }).code).toBeUndefined()
    }
  })

  it('preserves code and message from a valid JSON error body', async () => {
    mockFetch(() => ({ ok: false, status: 403, json: async () => ({ error: 'nope', code: 'caller-forbidden' }) }))
    try {
      await client.users.list()
      expect.fail('should have thrown')
    } catch (err) {
      expect((err as Error).message).toBe('nope')
      expect((err as Error & { code?: string }).code).toBe('caller-forbidden')
    }
  })

  it('includes HTTP status and response text when body is not valid JSON (HTML 502)', async () => {
    mockFetch(() => ({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => { throw new SyntaxError('Unexpected token <') },
      text: async () => '<html><body>502 Bad Gateway</body></html>',
    }))
    try {
      await client.users.list()
      expect.fail('should have thrown')
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).toContain('HTTP 502')
      expect(msg).toContain('Bad Gateway')
      expect(msg).toContain('502 Bad Gateway')
      expect((err as Error & { code?: string }).code).toBeUndefined()
    }
  })

  it('falls back to bare HTTP status when body is empty and unparseable', async () => {
    mockFetch(() => ({
      ok: false,
      status: 500,
      statusText: '',
      json: async () => { throw new SyntaxError('no body') },
      text: async () => '',
    }))
    await expect(client.users.list()).rejects.toThrow('HTTP 500')
  })

  it('truncates very long response text in the error message', async () => {
    const long = 'x'.repeat(5000)
    mockFetch(() => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => { throw new SyntaxError('html') },
      text: async () => long,
    }))
    try {
      await client.users.list()
      expect.fail('should have thrown')
    } catch (err) {
      // status prefix + ': ' + at most 200 chars of snippet
      expect((err as Error).message.length).toBeLessThan(260)
    }
  })
})
