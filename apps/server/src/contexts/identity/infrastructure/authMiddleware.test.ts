import { describe, it, expect, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { openDatabase, type DatabaseSync } from '../../../platform/db/connection.ts'
import { migrate } from '../../../platform/db/migrations.ts'
import { createUserRepo, type UserRepo } from './persistence/userRepo.ts'
import { createSessionRepo, type SessionRepo } from './persistence/sessionRepo.ts'
import {
  makeRequireAuth,
  makeResolveProfile,
  isAllowlisted,
  tokenFromRequest,
  SESSION_COOKIE,
  AUTH_ALLOWLIST,
} from './authMiddleware.ts'

function buildApp(sessions: SessionRepo, users: UserRepo): FastifyInstance {
  const app = Fastify()
  app.addHook('onRequest', makeRequireAuth(sessions, users))
  app.get('/health', async () => ({ ok: true }))
  app.post('/auth/login', async () => ({ ok: true }))
  app.get('/me', async req => ({ user: req.user ?? null }))
  return app
}

describe('auth/middleware', () => {
  describe('isAllowlisted', () => {
    it('exempts every documented allowlist path', () => {
      for (const p of AUTH_ALLOWLIST) expect(isAllowlisted(p)).toBe(true)
    })
    it('exempts static asset prefixes', () => {
      expect(isAllowlisted('/assets/index-abc123.js')).toBe(true)
    })
    it('does not exempt protected routes', () => {
      expect(isAllowlisted('/auth/me')).toBe(false)
      expect(isAllowlisted('/library')).toBe(false)
    })
    it('exempts GET /users (profile picker) but not its mutating verbs', () => {
      // Pre-login Guard + login profile picker read GET /users unauthenticated.
      expect(isAllowlisted('/users', 'GET')).toBe(true)
      // Path-only (no method) stays gated, and other verbs require a session.
      expect(isAllowlisted('/users')).toBe(false)
      expect(isAllowlisted('/users', 'POST')).toBe(false)
      expect(isAllowlisted('/users', 'PATCH')).toBe(false)
      expect(isAllowlisted('/users', 'DELETE')).toBe(false)
    })
  })

  describe('tokenFromRequest', () => {
    it('reads the hz_session cookie', () => {
      const req = { headers: { cookie: `${SESSION_COOKIE}=abc123; other=x` } } as never
      expect(tokenFromRequest(req)).toBe('abc123')
    })
    it('reads a Bearer token', () => {
      const req = { headers: { authorization: 'Bearer tok-xyz' } } as never
      expect(tokenFromRequest(req)).toBe('tok-xyz')
    })
    it('prefers the cookie over the bearer header', () => {
      const req = { headers: { cookie: `${SESSION_COOKIE}=cookie-tok`, authorization: 'Bearer bearer-tok' } } as never
      expect(tokenFromRequest(req)).toBe('cookie-tok')
    })
    it('returns null when neither is present', () => {
      expect(tokenFromRequest({ headers: {} } as never)).toBeNull()
    })
  })

  describe('hook', () => {
    let db: DatabaseSync
    let users: UserRepo
    let sessions: SessionRepo
    let app: FastifyInstance
    let token: string

    beforeEach(async () => {
      db = openDatabase(':memory:')
      migrate(db)
      users = createUserRepo(db)
      sessions = createSessionRepo(db)
      const u = users.create({ name: 'Alice' })
      token = sessions.issue(u.id).token
      app = buildApp(sessions, users)
      await app.ready()
    })

    it('allows allowlisted routes without a token', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' })
      expect(res.statusCode).toBe(200)
    })

    it('401s a protected route with no token', async () => {
      const res = await app.inject({ method: 'GET', url: '/me' })
      expect(res.statusCode).toBe(401)
      expect(res.json().code).toBe('unauthorized')
    })

    it('authenticates via the hz_session cookie and sets req.user', async () => {
      const res = await app.inject({ method: 'GET', url: '/me', cookies: { [SESSION_COOKIE]: token } })
      expect(res.statusCode).toBe(200)
      expect(res.json().user.role).toBe('owner')
    })

    it('authenticates via Authorization: Bearer', async () => {
      const res = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${token}` } })
      expect(res.statusCode).toBe(200)
      expect(res.json().user.id).toBeTruthy()
    })

    it('401s an expired session', async () => {
      db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash IS NOT NULL').run(Date.now() - 1)
      const res = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${token}` } })
      expect(res.statusCode).toBe(401)
    })

    it('401s when the session\'s user has been deleted', async () => {
      db.prepare('DELETE FROM users').run() // cascades to sessions, but token resolve handles miss
      const res = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${token}` } })
      expect(res.statusCode).toBe(401)
    })
  })

  describe('resolveProfile', () => {
    // Minimal fakes — resolveProfile only needs req.user, the profile header, and
    // a way to fetch the session grant for the principal's current token.
    function reqWith(profileHeader: string | undefined, grant: string[]) {
      return {
        user: { id: 'principal', role: 'member' as const },
        headers: profileHeader ? { 'x-horizon-profile': profileHeader, authorization: 'Bearer t' } : { authorization: 'Bearer t' },
        // resolveProfile resolves the session by token to read its grant:
        __grant: grant,
      } as any
    }
    const sessionRepo = { resolve: (_t: string) => ({ userId: 'principal', grant: ['principal', 'partner'] }) } as any
    const userRepo = { get: (id: string) => ({ id, role: 'member' }) } as any
    const hook = makeResolveProfile(sessionRepo, userRepo)

    it('defaults profileUserId to the principal when no header', async () => {
      const req = reqWith(undefined, ['principal'])
      const reply = { code: () => reply, send: () => reply } as any
      await hook(req, reply)
      expect(req.profileUserId).toBe('principal')
    })

    it('accepts a profile in the grant', async () => {
      const req = reqWith('partner', ['principal', 'partner'])
      const reply = { code: () => reply, send: () => reply } as any
      await hook(req, reply)
      expect(req.profileUserId).toBe('partner')
    })

    it('rejects a profile not in the grant with 403 profile-not-granted', async () => {
      const req = reqWith('stranger', ['principal', 'partner'])
      let status = 0; let body: any
      const reply = { status: (c: number) => { status = c; return reply }, send: (b: any) => { body = b; return reply } } as any
      await hook(req, reply)
      expect(status).toBe(403)
      expect(body.code).toBe('profile-not-granted')
      expect(req.profileUserId).toBeUndefined()
    })
  })
})
