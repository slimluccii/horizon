import { describe, it, expect, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { openDatabase, type DatabaseSync } from '../../../../platform/db/connection.ts'
import { migrate } from '../../../../platform/db/migrations.ts'
import { createUserRepo, type UserRepo } from '../persistence/userRepo.ts'
import { createSessionRepo, type SessionRepo } from '../persistence/sessionRepo.ts'
import { createHouseholdRepo, type HouseholdRepo } from '../persistence/householdRepo.ts'
import { makeRequireAuth, SESSION_COOKIE } from '../authMiddleware.ts'
import { registerAuth, validateGrant } from './auth.ts'
import { registerUsers } from './users.ts'
import { hash } from '../password.ts'

/**
 * End-to-end tests for the auth routes against a real app: the requireAuth hook
 * is installed (so authenticated endpoints behave exactly as in production) and
 * sessions are minted by the login/set-password/pairing flows themselves.
 */
async function buildApp(db: DatabaseSync, users: UserRepo, sessions: SessionRepo, households: HouseholdRepo): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await registerAuth(app, users, sessions, households)
  app.addHook('onRequest', makeRequireAuth(sessions, users))
  // A trivial protected route to exercise cookie/bearer auth end-to-end.
  app.get('/protected', async req => ({ id: req.user?.id }))
  await app.ready()
  return app
}

/** Create a user with a known password set. */
async function makeUserWithPassword(users: UserRepo, name: string, password: string) {
  const u = users.create({ name })
  users.setPassword(u.id, await hash(password))
  return users.get(u.id)!
}

describe('auth routes', () => {
  let db: DatabaseSync
  let users: UserRepo
  let sessions: SessionRepo
  let households: HouseholdRepo
  let app: FastifyInstance

  beforeEach(async () => {
    db = openDatabase(':memory:')
    migrate(db)
    users = createUserRepo(db)
    sessions = createSessionRepo(db)
    households = createHouseholdRepo(db)
    app = await buildApp(db, users, sessions, households)
  })

  describe('POST /auth/login', () => {
    it('logs in with the correct password, sets the cookie, returns token + user', async () => {
      const u = await makeUserWithPassword(users, 'Alice', 'correct horse')
      const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { name: 'Alice', password: 'correct horse' } })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.token).toBeTruthy()
      expect(body.user.id).toBe(u.id)
      expect(body.user.hasPassword).toBe(true)
      // Set-Cookie carries the httpOnly session cookie.
      const setCookie = res.headers['set-cookie']
      const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie)
      expect(cookieStr).toContain(`${SESSION_COOKIE}=`)
      expect(cookieStr.toLowerCase()).toContain('httponly')
    })

    it('is case-insensitive on the name', async () => {
      await makeUserWithPassword(users, 'Alice', 'pw12345678')
      const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { name: 'alice', password: 'pw12345678' } })
      expect(res.statusCode).toBe(200)
    })

    it('rejects a wrong password with a generic 401 invalid-credentials', async () => {
      await makeUserWithPassword(users, 'Alice', 'correct horse')
      const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { name: 'Alice', password: 'wrong' } })
      expect(res.statusCode).toBe(401)
      expect(res.json().code).toBe('invalid-credentials')
    })

    it('returns the same generic error for an unknown user (no enumeration)', async () => {
      await makeUserWithPassword(users, 'Alice', 'correct horse')
      const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { name: 'Nobody', password: 'whatever' } })
      expect(res.statusCode).toBe(401)
      expect(res.json().code).toBe('invalid-credentials')
    })

    it('returns generic error for a user with no password set', async () => {
      users.create({ name: 'Alice' }) // no password
      const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { name: 'Alice', password: 'x' } })
      expect(res.statusCode).toBe(401)
      expect(res.json().code).toBe('invalid-credentials')
    })

    it('locks the account after 5 consecutive failures (429 account-locked)', async () => {
      await makeUserWithPassword(users, 'Alice', 'correct horse')
      for (let i = 0; i < 4; i++) {
        const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { name: 'Alice', password: 'bad' } })
        expect(r.statusCode).toBe(401)
      }
      // 5th failure trips the lockout.
      const fifth = await app.inject({ method: 'POST', url: '/auth/login', payload: { name: 'Alice', password: 'bad' } })
      expect(fifth.statusCode).toBe(429)
      expect(fifth.json().code).toBe('account-locked')
      // Even the correct password is now refused while locked.
      const locked = await app.inject({ method: 'POST', url: '/auth/login', payload: { name: 'Alice', password: 'correct horse' } })
      expect(locked.statusCode).toBe(429)
      expect(locked.json().code).toBe('account-locked')
    })

    it('a successful login clears the failed-attempt counter', async () => {
      const u = await makeUserWithPassword(users, 'Alice', 'correct horse')
      await app.inject({ method: 'POST', url: '/auth/login', payload: { name: 'Alice', password: 'bad' } })
      await app.inject({ method: 'POST', url: '/auth/login', payload: { name: 'Alice', password: 'correct horse' } })
      expect(users.getAuthById(u.id)!.failedAttempts).toBe(0)
      expect(users.getAuthById(u.id)!.lockedUntil).toBeNull()
    })
  })

  describe('GET /auth/me', () => {
    it('returns the user for a valid bearer token', async () => {
      const u = await makeUserWithPassword(users, 'Alice', 'pw12345678')
      const token = sessions.issue(u.id).token
      const res = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } })
      expect(res.statusCode).toBe(200)
      expect(res.json().id).toBe(u.id)
    })

    it('401s without a session', async () => {
      const res = await app.inject({ method: 'GET', url: '/auth/me' })
      expect(res.statusCode).toBe(401)
      expect(res.json().code).toBe('unauthorized')
    })

    it('works via the hz_session cookie too', async () => {
      const u = await makeUserWithPassword(users, 'Alice', 'pw12345678')
      const token = sessions.issue(u.id).token
      const res = await app.inject({ method: 'GET', url: '/auth/me', cookies: { [SESSION_COOKIE]: token } })
      expect(res.statusCode).toBe(200)
      expect(res.json().id).toBe(u.id)
    })
  })

  describe('POST /auth/logout', () => {
    it('revokes the current session and clears the cookie', async () => {
      const u = await makeUserWithPassword(users, 'Alice', 'pw12345678')
      const token = sessions.issue(u.id).token
      const res = await app.inject({ method: 'POST', url: '/auth/logout', headers: { authorization: `Bearer ${token}` } })
      expect(res.statusCode).toBe(200)
      // The session is gone — a follow-up /protected with the same token 401s.
      const after = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${token}` } })
      expect(after.statusCode).toBe(401)
    })
  })

  describe('POST /auth/logout-all', () => {
    it('revokes every session for the caller', async () => {
      const u = await makeUserWithPassword(users, 'Alice', 'pw12345678')
      const t1 = sessions.issue(u.id).token
      const t2 = sessions.issue(u.id).token
      const res = await app.inject({ method: 'POST', url: '/auth/logout-all', headers: { authorization: `Bearer ${t1}` } })
      expect(res.statusCode).toBe(200)
      expect(res.json().revoked).toBeGreaterThanOrEqual(2)
      // Both tokens are now dead.
      for (const t of [t1, t2]) {
        const after = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${t}` } })
        expect(after.statusCode).toBe(401)
      }
    })
  })

  describe('POST /auth/set-password', () => {
    it('first-boot owner (password_set_at null) sets their own password without an old one', async () => {
      const owner = users.create({ name: 'Owner' }) // never set a password
      const token = sessions.issue(owner.id).token
      const res = await app.inject({
        method: 'POST', url: '/auth/set-password',
        headers: { authorization: `Bearer ${token}` },
        payload: { newPassword: 'brand new password' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().user.hasPassword).toBe(true)
      // A fresh session is issued for the caller.
      expect(res.json().token).toBeTruthy()
      expect(users.getAuthById(owner.id)!.passwordSetAt).not.toBeNull()
    })

    it('self change requires the correct old password once one is set', async () => {
      const u = await makeUserWithPassword(users, 'Alice', 'old password')
      const token = sessions.issue(u.id).token
      const wrong = await app.inject({
        method: 'POST', url: '/auth/set-password',
        headers: { authorization: `Bearer ${token}` },
        payload: { oldPassword: 'nope', newPassword: 'new password!!' },
      })
      expect(wrong.statusCode).toBe(401)
      expect(wrong.json().code).toBe('invalid-credentials')

      const ok = await app.inject({
        method: 'POST', url: '/auth/set-password',
        headers: { authorization: `Bearer ${token}` },
        payload: { oldPassword: 'old password', newPassword: 'new password!!' },
      })
      expect(ok.statusCode).toBe(200)
      // The new password now logs in.
      const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { name: 'Alice', password: 'new password!!' } })
      expect(login.statusCode).toBe(200)
    })

    it('rejects a too-short new password with weak-password', async () => {
      const u = await makeUserWithPassword(users, 'Alice', 'old password')
      const token = sessions.issue(u.id).token
      const res = await app.inject({
        method: 'POST', url: '/auth/set-password',
        headers: { authorization: `Bearer ${token}` },
        payload: { oldPassword: 'old password', newPassword: 'short' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().code).toBe('weak-password')
    })

    it('owner can reset another user without their old password', async () => {
      const owner = await makeUserWithPassword(users, 'Owner', 'owner password')
      const member = await makeUserWithPassword(users, 'Member', 'member password')
      const token = sessions.issue(owner.id).token
      const res = await app.inject({
        method: 'POST', url: '/auth/set-password',
        headers: { authorization: `Bearer ${token}` },
        payload: { userId: member.id, newPassword: 'reset by owner!' },
      })
      expect(res.statusCode).toBe(200)
      const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { name: 'Member', password: 'reset by owner!' } })
      expect(login.statusCode).toBe(200)
    })

    it('a member cannot reset another user (403 caller-forbidden)', async () => {
      await makeUserWithPassword(users, 'Owner', 'owner password') // owner
      const member = await makeUserWithPassword(users, 'Member', 'member password')
      const victim = await makeUserWithPassword(users, 'Victim', 'victim password')
      const token = sessions.issue(member.id).token
      const res = await app.inject({
        method: 'POST', url: '/auth/set-password',
        headers: { authorization: `Bearer ${token}` },
        payload: { userId: victim.id, newPassword: 'hijacked pw!' },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json().code).toBe('caller-forbidden')
    })
  })

  describe('pairing flow', () => {
    it('start → approve → poll issues a session for the approver, then 410 on re-poll', async () => {
      const owner = await makeUserWithPassword(users, 'Owner', 'owner password')
      const home = households.create('Home', owner.id)
      users.setHousehold(owner.id, home.id)
      const ownerToken = sessions.issue(owner.id).token

      // TV starts pairing (unauthenticated).
      const start = await app.inject({ method: 'POST', url: '/auth/pair/start' })
      expect(start.statusCode).toBe(200)
      const { code, expiresAt } = start.json()
      expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
      expect(expiresAt).toBeGreaterThan(Date.now())

      // Poll before approval → pending (202).
      const pending = await app.inject({ method: 'POST', url: '/auth/pair/poll', payload: { code } })
      expect(pending.statusCode).toBe(202)
      expect(pending.json().status).toBe('pending')

      // Phone/web approves (authenticated).
      const approve = await app.inject({
        method: 'POST', url: '/auth/pair/approve',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { code },
      })
      expect(approve.statusCode).toBe(200)

      // Poll now mints a session bound to the approver.
      const poll = await app.inject({ method: 'POST', url: '/auth/pair/poll', payload: { code } })
      expect(poll.statusCode).toBe(200)
      expect(poll.json().token).toBeTruthy()
      expect(poll.json().user.id).toBe(owner.id)

      // Re-poll a consumed code → 410 pairing-expired.
      const rePoll = await app.inject({ method: 'POST', url: '/auth/pair/poll', payload: { code } })
      expect(rePoll.statusCode).toBe(410)
      expect(rePoll.json().code).toBe('pairing-expired')
    })

    it('owner approve with an explicit grant → poll returns the granted profiles', async () => {
      const owner = await makeUserWithPassword(users, 'Owner', 'owner password')
      const home = households.create('Home', owner.id)
      users.setHousehold(owner.id, home.id)
      const partner = users.create({ name: 'Partner', householdId: home.id })
      const ownerToken = sessions.issue(owner.id).token

      const { code } = (await app.inject({ method: 'POST', url: '/auth/pair/start' })).json()
      const approve = await app.inject({
        method: 'POST', url: '/auth/pair/approve',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { code, grant: [owner.id, partner.id] },
      })
      expect(approve.statusCode).toBe(200)

      const poll = await app.inject({ method: 'POST', url: '/auth/pair/poll', payload: { code } })
      expect(poll.statusCode).toBe(200)
      const body = poll.json()
      expect(body.grant).toEqual([owner.id, partner.id])
      expect(body.profiles.map((p: { id: string }) => p.id)).toEqual([owner.id, partner.id])
      expect(body.profiles.map((p: { name: string }) => p.name)).toEqual(['Owner', 'Partner'])

      // The minted session can read its grant back via GET /auth/grant.
      const grant = await app.inject({
        method: 'GET', url: '/auth/grant',
        headers: { authorization: `Bearer ${body.token}` },
      })
      expect(grant.statusCode).toBe(200)
      expect(grant.json().profiles.map((p: { id: string }) => p.id)).toEqual([owner.id, partner.id])
    })

    it('member approver cannot grant another profile (403 grant-forbidden)', async () => {
      const owner = await makeUserWithPassword(users, 'Owner', 'owner password')
      const home = households.create('Home', owner.id)
      users.setHousehold(owner.id, home.id)
      const member = users.create({ name: 'Member', householdId: home.id })
      const memberToken = sessions.issue(member.id).token

      const { code } = (await app.inject({ method: 'POST', url: '/auth/pair/start' })).json()
      const approve = await app.inject({
        method: 'POST', url: '/auth/pair/approve',
        headers: { authorization: `Bearer ${memberToken}` },
        payload: { code, grant: [owner.id] },
      })
      expect(approve.statusCode).toBe(403)
      expect(approve.json().code).toBe('grant-forbidden')
    })

    it('approver without a household is rejected (403 caller-forbidden)', async () => {
      const loner = await makeUserWithPassword(users, 'Loner', 'loner password')
      const lonerToken = sessions.issue(loner.id).token
      const { code } = (await app.inject({ method: 'POST', url: '/auth/pair/start' })).json()
      const approve = await app.inject({
        method: 'POST', url: '/auth/pair/approve',
        headers: { authorization: `Bearer ${lonerToken}` },
        payload: { code },
      })
      expect(approve.statusCode).toBe(403)
      expect(approve.json().code).toBe('caller-forbidden')
    })

    it('approve requires authentication (401)', async () => {
      const start = await app.inject({ method: 'POST', url: '/auth/pair/start' })
      const { code } = start.json()
      const res = await app.inject({ method: 'POST', url: '/auth/pair/approve', payload: { code } })
      expect(res.statusCode).toBe(401)
      expect(res.json().code).toBe('unauthorized')
    })

    it('poll for an unknown code → 404 pairing-not-found', async () => {
      const res = await app.inject({ method: 'POST', url: '/auth/pair/poll', payload: { code: 'ZZZZ-9999' } })
      expect(res.statusCode).toBe(404)
      expect(res.json().code).toBe('pairing-not-found')
    })

    it('approve an expired code → 410 pairing-expired', async () => {
      const owner = await makeUserWithPassword(users, 'Owner', 'owner password')
      const ownerToken = sessions.issue(owner.id).token
      const start = await app.inject({ method: 'POST', url: '/auth/pair/start' })
      const { code } = start.json()
      // Force expiry in the DB.
      db.prepare('UPDATE pairing_codes SET expires_at = ? WHERE code = ?').run(Date.now() - 1, code)
      const res = await app.inject({
        method: 'POST', url: '/auth/pair/approve',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { code },
      })
      expect(res.statusCode).toBe(410)
      expect(res.json().code).toBe('pairing-expired')
    })
  })

  // Full first-boot web flow: empty DB → POST /users (allowlisted) creates the
  // owner AND issues a session → that session authenticates POST /auth/set-password.
  // Regression for the bug where create issued no session, so set-password 401'd
  // and the app was unusable on first boot.
  describe('first-boot setup flow', () => {
    async function buildSetupApp(): Promise<FastifyInstance> {
      const app = Fastify({ logger: false })
      await registerAuth(app, users, sessions, households)
      // Mirror server.ts: first-boot POST /users (empty household) bypasses the guard.
      const requireAuth = makeRequireAuth(sessions, users)
      app.addHook('onRequest', async (req, reply) => {
        const path = req.routeOptions?.url ?? req.url.split('?')[0]
        if (req.method === 'POST' && path === '/users' && users.list().length === 0) return
        return requireAuth(req, reply)
      })
      registerUsers(app, users, sessions, households)
      await app.ready()
      return app
    }

    it('create owner issues a session (cookie + token) that authenticates set-password', async () => {
      const setupApp = await buildSetupApp()

      // 1) Empty DB → create owner. No auth sent; response carries a token and
      //    a Set-Cookie session.
      const create = await setupApp.inject({ method: 'POST', url: '/users', payload: { name: 'Luuk' } })
      expect(create.statusCode).toBe(200)
      const created = create.json()
      expect(created.role).toBe('owner')
      expect(created.token).toBeTruthy()
      const setCookie = create.headers['set-cookie']
      const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie)
      expect(cookieStr).toContain(`${SESSION_COOKIE}=`)
      expect(cookieStr.toLowerCase()).toContain('httponly')

      // 2) Use the returned bearer token (native-client path) to set the password.
      const setPw = await setupApp.inject({
        method: 'POST', url: '/auth/set-password',
        headers: { authorization: `Bearer ${created.token}` },
        payload: { newPassword: 'first boot password' },
      })
      expect(setPw.statusCode).toBe(200)
      expect(setPw.json().user.hasPassword).toBe(true)

      // 3) The owner can now log in with that password.
      const login = await setupApp.inject({
        method: 'POST', url: '/auth/login',
        payload: { name: 'Luuk', password: 'first boot password' },
      })
      expect(login.statusCode).toBe(200)
      expect(login.json().user.id).toBe(created.id)
    })

    it('the create-owner cookie also authenticates set-password (web path)', async () => {
      const setupApp = await buildSetupApp()
      const create = await setupApp.inject({ method: 'POST', url: '/users', payload: { name: 'Web Owner' } })
      const setCookie = create.headers['set-cookie']
      const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie)
      // Extract hz_session=<token> to replay as the request Cookie header.
      const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(cookieStr)
      expect(m).not.toBeNull()
      const setPw = await setupApp.inject({
        method: 'POST', url: '/auth/set-password',
        headers: { cookie: `${SESSION_COOKIE}=${m![1]}` },
        payload: { newPassword: 'cookie set password' },
      })
      expect(setPw.statusCode).toBe(200)
      expect(setPw.json().user.hasPassword).toBe(true)
    })

    it('a second unauthenticated create is rejected by the auth guard', async () => {
      const setupApp = await buildSetupApp()
      // First create = owner (allowlisted while the household is empty).
      await setupApp.inject({ method: 'POST', url: '/users', payload: { name: 'Owner' } })
      // Household is no longer empty, so POST /users is no longer allowlisted —
      // the global auth guard rejects the unauthenticated request with 401.
      const res = await setupApp.inject({ method: 'POST', url: '/users', payload: { name: 'Stranger' } })
      expect(res.statusCode).toBe(401)
      expect(res.json().code).toBe('unauthorized')
    })
  })
})

describe('validateGrant', () => {
  const members = ['owner', 'partner', 'kid']
  it('owner: omitted grant fills to all household members', () => {
    expect(validateGrant({ approverId: 'owner', isHouseholdOwner: true, householdMemberIds: members, requested: undefined }))
      .toEqual({ ok: true, grant: members })
  })
  it('owner: explicit subset allowed', () => {
    expect(validateGrant({ approverId: 'owner', isHouseholdOwner: true, householdMemberIds: members, requested: ['owner', 'partner'] }))
      .toEqual({ ok: true, grant: ['owner', 'partner'] })
  })
  it('owner: id outside the household rejected', () => {
    expect(validateGrant({ approverId: 'owner', isHouseholdOwner: true, householdMemberIds: members, requested: ['owner', 'stranger'] }).ok)
      .toBe(false)
  })
  it('member: only self allowed; omitted → self', () => {
    expect(validateGrant({ approverId: 'partner', isHouseholdOwner: false, householdMemberIds: members, requested: undefined }))
      .toEqual({ ok: true, grant: ['partner'] })
    expect(validateGrant({ approverId: 'partner', isHouseholdOwner: false, householdMemberIds: members, requested: ['owner'] }).ok)
      .toBe(false)
  })
})
