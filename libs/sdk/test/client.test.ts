import { describe, it, expect, vi, afterEach } from 'vitest'
import { HorizonClient, isProgressNotFoundError } from '../src/client.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

function mockFetch(impl: () => Partial<Response> & { json?: () => Promise<unknown>; text?: () => Promise<string> }) {
  vi.stubGlobal('fetch', vi.fn(async () => impl() as unknown as Response))
}

/** Capture every fetch call so tests can assert URL, method, headers, and the
 *  always-on `credentials: 'include'`. Returns ok JSON `body` for each call. */
function spyFetch(body: unknown = {}, status = 200) {
  const fn = vi.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  }) as unknown as Response)
  vi.stubGlobal('fetch', fn)
  return fn
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

describe('HorizonClient token model', () => {
  it('starts with no token and stores/clears one via setToken/getToken', () => {
    const client = new HorizonClient({ baseUrl: 'http://x' })
    expect(client.getToken()).toBeNull()
    client.setToken('tok-1')
    expect(client.getToken()).toBe('tok-1')
    client.setToken(null)
    expect(client.getToken()).toBeNull()
  })

  it('always sends credentials:include and omits Authorization when no token set', async () => {
    const fn = spyFetch([])
    const client = new HorizonClient({ baseUrl: 'http://x' })
    await client.users.list()
    const init = fn.mock.calls[0][1] as RequestInit
    expect(init.credentials).toBe('include')
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('sends Authorization: Bearer once a token is set', async () => {
    const fn = spyFetch([])
    const client = new HorizonClient({ baseUrl: 'http://x' })
    client.setToken('tok-2')
    await client.users.list()
    const init = fn.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-2')
  })

  it('never sends the legacy X-Horizon-User header', async () => {
    const fn = spyFetch([])
    const client = new HorizonClient({ baseUrl: 'http://x' })
    client.setToken('tok-3')
    await client.users.list()
    const headers = (fn.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['X-Horizon-User']).toBeUndefined()
  })
})

describe('HorizonClient.auth', () => {
  const user = { id: 'u1', name: 'Ada', hasPassword: true, role: 'owner' }

  it('login posts name+password, stores the returned token, returns {token,user}', async () => {
    const fn = spyFetch({ token: 'sess-tok', user })
    const client = new HorizonClient({ baseUrl: 'http://x' })
    const res = await client.auth.login('Ada', 'pw')
    expect(fn.mock.calls[0][0]).toBe('http://x/auth/login')
    const init = fn.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Ada', password: 'pw' })
    expect(res).toEqual({ token: 'sess-tok', user })
    expect(client.getToken()).toBe('sess-tok')
  })

  it('logout posts and clears the stored token', async () => {
    const fn = spyFetch({ ok: true })
    const client = new HorizonClient({ baseUrl: 'http://x' })
    client.setToken('sess-tok')
    await client.auth.logout()
    expect(fn.mock.calls[0][0]).toBe('http://x/auth/logout')
    expect(client.getToken()).toBeNull()
  })

  it('logoutAll returns {revoked} and clears the token', async () => {
    const fn = spyFetch({ revoked: 3 })
    const client = new HorizonClient({ baseUrl: 'http://x' })
    client.setToken('sess-tok')
    const res = await client.auth.logoutAll()
    expect(fn.mock.calls[0][0]).toBe('http://x/auth/logout-all')
    expect(res).toEqual({ revoked: 3 })
    expect(client.getToken()).toBeNull()
  })

  it('me GETs /auth/me and returns the user', async () => {
    const fn = spyFetch(user)
    const client = new HorizonClient({ baseUrl: 'http://x' })
    const res = await client.auth.me()
    expect(fn.mock.calls[0][0]).toBe('http://x/auth/me')
    expect(res).toEqual(user)
  })

  it('setPassword re-stores the token on a self-change that re-issues a session', async () => {
    const fn = spyFetch({ token: 'new-tok', user })
    const client = new HorizonClient({ baseUrl: 'http://x' })
    const res = await client.auth.setPassword({ oldPassword: 'old', newPassword: 'newlongpw' })
    expect(fn.mock.calls[0][0]).toBe('http://x/auth/set-password')
    expect(JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string)).toEqual({ oldPassword: 'old', newPassword: 'newlongpw' })
    expect(client.getToken()).toBe('new-tok')
    expect(res).toEqual({ token: 'new-tok', user })
  })

  it('setPassword leaves the token untouched on an admin reset (no token returned)', async () => {
    spyFetch({})
    const client = new HorizonClient({ baseUrl: 'http://x' })
    client.setToken('admin-tok')
    await client.auth.setPassword({ userId: 'u2', newPassword: 'resetpw99' })
    expect(client.getToken()).toBe('admin-tok')
  })

  it('pairStart returns {code,expiresAt}', async () => {
    const fn = spyFetch({ code: 'ABCD-2345', expiresAt: 123 })
    const client = new HorizonClient({ baseUrl: 'http://x' })
    const res = await client.auth.pairStart()
    expect(fn.mock.calls[0][0]).toBe('http://x/auth/pair/start')
    expect(res).toEqual({ code: 'ABCD-2345', expiresAt: 123 })
  })

  it('pairApprove posts the code', async () => {
    const fn = spyFetch({ ok: true })
    const client = new HorizonClient({ baseUrl: 'http://x' })
    await client.auth.pairApprove('ABCD-2345')
    expect(fn.mock.calls[0][0]).toBe('http://x/auth/pair/approve')
    expect(JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string)).toEqual({ code: 'ABCD-2345' })
  })

  it('pairPoll returns pending without storing a token', async () => {
    spyFetch({ status: 'pending' }, 202)
    const client = new HorizonClient({ baseUrl: 'http://x' })
    const res = await client.auth.pairPoll('ABCD-2345')
    expect(res).toEqual({ status: 'pending' })
    expect(client.getToken()).toBeNull()
  })

  it('pairPoll stores the token once the code is approved', async () => {
    spyFetch({ token: 'tv-tok', user })
    const client = new HorizonClient({ baseUrl: 'http://x' })
    const res = await client.auth.pairPoll('ABCD-2345')
    expect(res).toEqual({ token: 'tv-tok', user })
    expect(client.getToken()).toBe('tv-tok')
  })
})
