import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { openDatabase, type DatabaseSync } from '../../../../platform/db/connection.ts'
import { migrate } from '../../../../platform/db/migrations.ts'
import { createUserRepo, type UserRepo } from '../persistence/userRepo.ts'
import { createSessionRepo } from '../persistence/sessionRepo.ts'
import { createHouseholdRepo } from '../persistence/householdRepo.ts'
import { makeRequireAuth } from '../authMiddleware.ts'
import { registerUsers } from './users.ts'
import fastifyCookie from '@fastify/cookie'
import { SUPPORTED_LANGUAGES } from '@horizon/sdk/preferences'

// Session-auth cutover: tests authenticate with a real session bearer token
// (no more X-Horizon-User header). buildApp installs the production auth guard
// hook; `hdr(db, userId)` mints a token and returns the Authorization header.
async function buildApp(users: UserRepo, db: DatabaseSync) {
  const app = Fastify({ logger: false })
  const sessions = createSessionRepo(db)
  // First-boot POST /users sets the session cookie, which needs @fastify/cookie
  // registered (in production registerAuth does this before registerUsers).
  await app.register(fastifyCookie)
  const households = createHouseholdRepo(db)
  const requireAuth = makeRequireAuth(sessions, users)
  // Mirror server.ts: first-boot POST /users (empty household) bypasses the guard.
  app.addHook('onRequest', async (req, reply) => {
    const path = req.routeOptions?.url ?? req.url.split('?')[0]
    if (req.method === 'POST' && path === '/users' && users.list().length === 0) return
    return requireAuth(req, reply)
  })
  registerUsers(app, users, sessions, households)
  await app.ready()
  return app
}

function hdr(db: DatabaseSync, userId: string): { authorization: string } {
  const token = createSessionRepo(db).issue(userId).token
  return { authorization: `Bearer ${token}` }
}

describe('POST /users', () => {
  it('creates a user', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'POST', url: '/users', payload: { name: 'Luuk' } })
    expect(res.statusCode).toBe(200)
    const body = res.json() as any
    expect(body.name).toBe('Luuk')
  })

  it('rejects missing name', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'POST', url: '/users', payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('409 on duplicate name', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Luuk' })
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'POST', url: '/users', payload: { name: 'luuk' }, headers: hdr(db, owner.id) })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('name-taken')
  })

  it('first POST returns role owner', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'POST', url: '/users', payload: { name: 'Alice' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().role).toBe('owner')
  })

  it('second POST returns role member', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Alice' })
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'POST', url: '/users', payload: { name: 'Bob' }, headers: hdr(db, owner.id) })
    expect(res.statusCode).toBe(200)
    expect(res.json().role).toBe('member')
  })

  it('rejects unauthenticated creation when users exist', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    users.create({ name: 'Alice' }) // owner
    const app = await buildApp(users, db)
    // Once the household is non-empty the first-boot bypass no longer applies,
    // so the global auth guard rejects the unauthenticated request with 401.
    const res = await app.inject({ method: 'POST', url: '/users', payload: { name: 'Bob' } })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthorized')
  })

  it('rejects member-authenticated creation when users exist', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    users.create({ name: 'Alice' }) // owner
    const member = users.create({ name: 'Bob' })
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'POST', url: '/users', payload: { name: 'Carol' }, headers: hdr(db, member.id) })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
  })

  it('first-boot owner is placed in a Home household they own', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const households = createHouseholdRepo(db)
    const app = await buildApp(users, db)
    // create the very first user via POST /users (unauthenticated first-boot path)
    const res = await app.inject({ method: 'POST', url: '/users', payload: { name: 'Owner' } })
    expect(res.statusCode).toBe(200)
    const id = res.json().id
    const u = users.get(id)!
    expect(u.householdId).not.toBeNull()
    expect(households.get(u.householdId!)!.ownerUserId).toBe(id)
  })

  it('allows unauthenticated creation on empty database', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'POST', url: '/users', payload: { name: 'Alice' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().role).toBe('owner')
  })
})

describe('GET /users and /users/:id', () => {
  it('lists users', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'A' })
    const app = await buildApp(users, db)
    const list = await app.inject({ method: 'GET', url: '/users', headers: hdr(db, owner.id) })
    expect(list.json()).toHaveLength(1)
  })

  it('authenticated GET /users returns only the caller household members', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const households = createHouseholdRepo(db)
    // Owner's household (Home) with the owner + one fellow member.
    const owner = users.create({ name: 'Owner' })
    const home = households.create('Home', owner.id).id
    users.setHousehold(owner.id, home)
    const housemate = users.create({ name: 'Housemate' })
    users.setHousehold(housemate.id, home)
    // A separate household whose member must not leak into the caller's list.
    const friendHousehold = households.create('Friend', null).id
    const friend = users.create({ name: 'Friend' })
    users.setHousehold(friend.id, friendHousehold)
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'GET', url: '/users', headers: hdr(db, owner.id) })
    expect(res.statusCode).toBe(200)
    const names = res.json().map((u: any) => u.name)
    expect(names).toContain('Owner')
    expect(names).toContain('Housemate')
    expect(names).not.toContain('Friend')
  })

  it('gets single user', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const u = users.create({ name: 'A' })
    const app = await buildApp(users, db)
    const one = await app.inject({ method: 'GET', url: `/users/${u.id}`, headers: hdr(db, u.id) })
    expect(one.json().id).toBe(u.id)
  })

  it('404 for missing user', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'A' })
    const app = await buildApp(users, db)
    const missing = await app.inject({ method: 'GET', url: '/users/missing', headers: hdr(db, owner.id) })
    expect(missing.statusCode).toBe(404)
  })
})

describe('GET /users/orphans', () => {
  it('returns null-household users to an admin; 403 for a member', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const households = createHouseholdRepo(db)
    // owner placed in a Home household; a fresh orphan (no household).
    const owner = users.create({ name: 'Owner' })
    const home = households.create('Home', owner.id).id
    users.setHousehold(owner.id, home)
    const orphan = users.create({ name: 'NoHome' })   // no household
    const app = await buildApp(users, db)

    const ok = await app.inject({ method: 'GET', url: '/users/orphans', headers: hdr(db, owner.id) })
    expect(ok.statusCode).toBe(200)
    expect((ok.json() as { id: string }[]).map(u => u.id)).toContain(orphan.id)

    const member = users.create({ name: 'Mm' }); users.setHousehold(member.id, home)
    const forbidden = await app.inject({ method: 'GET', url: '/users/orphans', headers: hdr(db, member.id) })
    expect(forbidden.statusCode).toBe(403)
  })
})

describe('PATCH + DELETE /users/:id', () => {
  it('patches name', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const u = users.create({ name: 'A' })
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'PATCH', url: `/users/${u.id}`, payload: { name: 'B' }, headers: hdr(db, u.id) })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('B')
  })

  it('PATCH own profile name as member returns 200', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    users.create({ name: 'Alice' }) // owner
    const member = users.create({ name: 'Bob' })
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'PATCH', url: `/users/${member.id}`, payload: { name: 'Bobby' }, headers: hdr(db, member.id) })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('Bobby')
  })

  it('PATCH own profile preferences as member returns 200', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    users.create({ name: 'Alice' }) // owner
    const member = users.create({ name: 'Bob' })
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'PATCH', url: `/users/${member.id}`, payload: { preferences: { theme: 'dark' } }, headers: hdr(db, member.id) })
    expect(res.statusCode).toBe(200)
    expect(res.json().preferences).toEqual({ theme: 'dark' })
  })

  it('PATCH other user profile name as member returns 403 (IDOR closed)', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Alice' })
    const member = users.create({ name: 'Bob' })
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'PATCH', url: `/users/${owner.id}`, payload: { name: 'Mallory' }, headers: hdr(db, member.id) })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
  })

  it('PATCH other user profile preferences as member returns 403 (IDOR closed)', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Alice' })
    const member = users.create({ name: 'Bob' })
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'PATCH', url: `/users/${owner.id}`, payload: { preferences: { theme: 'dark' } }, headers: hdr(db, member.id) })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
  })

  it('PATCH other user profile name as owner returns 403 (self-edit only)', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Alice' })
    const member = users.create({ name: 'Bob' })
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'PATCH', url: `/users/${member.id}`, payload: { name: 'Robert' }, headers: hdr(db, owner.id) })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
  })

  it('PATCH profile without a session returns 401 unauthorized', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const u = users.create({ name: 'A' })
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'PATCH', url: `/users/${u.id}`, payload: { name: 'B' } })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthorized')
  })

  it('deletes + subsequent 404', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'A' }) // owner
    const b = users.create({ name: 'B' }) // member
    const app = await buildApp(users, db)
    const del = await app.inject({ method: 'DELETE', url: `/users/${b.id}`, headers: hdr(db, owner.id) })
    expect(del.statusCode).toBe(204)
    const get = await app.inject({ method: 'GET', url: `/users/${b.id}`, headers: hdr(db, owner.id) })
    expect(get.statusCode).toBe(404)
  })

  it('DELETE without a session returns 401 unauthorized', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    users.create({ name: 'A' }) // owner
    const b = users.create({ name: 'B' }) // member
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'DELETE', url: `/users/${b.id}` })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthorized')
  })

  it('member cannot DELETE another user (403 caller-forbidden)', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    users.create({ name: 'A' }) // owner
    const member = users.create({ name: 'B' }) // member
    const victim = users.create({ name: 'C' }) // member
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'DELETE', url: `/users/${victim.id}`, headers: hdr(db, member.id) })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
    // Victim must still exist.
    expect(users.get(victim.id)).not.toBeNull()
  })

  it('DELETE owner (by owner) returns 403 owner-protected', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Alice' })
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'DELETE', url: `/users/${owner.id}`, headers: hdr(db, owner.id) })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('owner-protected')
  })

  // --- Household-scoped management (follow-up A) ----------------------------
  // Build: a server owner (no household needed), and two households A & B each
  // with a household-owner (server-role member) + a plain member.
  function household2(db: DatabaseSync, users: UserRepo) {
    const households = createHouseholdRepo(db)
    const srvOwner = users.create({ name: 'SrvOwner' })            // server role owner (first user)
    const hoA = users.create({ name: 'HoA' })                      // server role member
    const hA = households.create('A', hoA.id); users.setHousehold(hoA.id, hA.id)
    const memA = users.create({ name: 'MemA' }); users.setHousehold(memA.id, hA.id)
    const hoB = users.create({ name: 'HoB' })
    const hB = households.create('B', hoB.id); users.setHousehold(hoB.id, hB.id)
    const memB = users.create({ name: 'MemB' }); users.setHousehold(memB.id, hB.id)
    return { srvOwner, hoA, memA, hoB, memB }
  }

  it('household owner DELETEs a member of their OWN household (204)', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const { hoA, memA } = household2(db, users)
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'DELETE', url: `/users/${memA.id}`, headers: hdr(db, hoA.id) })
    expect(res.statusCode).toBe(204)
    expect(users.get(memA.id)).toBeNull()
  })

  it('household owner CANNOT DELETE a member of another household (403)', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const { hoA, memB } = household2(db, users)
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'DELETE', url: `/users/${memB.id}`, headers: hdr(db, hoA.id) })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
    expect(users.get(memB.id)).not.toBeNull()
  })

  it('a plain member (not household owner) CANNOT DELETE a household-mate (403)', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const { memA, hoA } = household2(db, users)
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'DELETE', url: `/users/${hoA.id}`, headers: hdr(db, memA.id) })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
  })

  it('server owner/admin DELETEs across households (escape hatch preserved)', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const { srvOwner, memB } = household2(db, users)   // srvOwner = server role owner
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'DELETE', url: `/users/${memB.id}`, headers: hdr(db, srvOwner.id) })
    expect(res.statusCode).toBe(204)
  })

  it('PATCH owner role to member returns 403 role-immutable', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Alice' })
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'PATCH', url: `/users/${owner.id}`, payload: { role: 'member' }, headers: hdr(db, owner.id) })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('role-immutable')
  })

  it('PATCH member role to owner returns 409 owner-exists', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Alice' })
    const member = users.create({ name: 'Bob' })
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'PATCH', url: `/users/${member.id}`, payload: { role: 'owner' }, headers: hdr(db, owner.id) })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('owner-exists')
  })

  it('PATCH role without a session returns 401 unauthorized', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    users.create({ name: 'Alice' })
    const member = users.create({ name: 'Bob' })
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'PATCH', url: `/users/${member.id}`, payload: { role: 'admin' } })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthorized')
  })

  it('PATCH role with caller role=member returns 403 caller-forbidden', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    users.create({ name: 'Alice' }) // owner
    const member = users.create({ name: 'Bob' })
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'PATCH', url: `/users/${member.id}`, payload: { role: 'admin' }, headers: hdr(db, member.id) })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
  })

  it('PATCH role with caller=owner demoting admin returns 200', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Alice' })
    const adminUser = users.create({ name: 'Bob' })
    users.update(adminUser.id, { role: 'admin' })
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'PATCH', url: `/users/${adminUser.id}`, payload: { role: 'member' }, headers: hdr(db, owner.id) })
    expect(res.statusCode).toBe(200)
    expect(res.json().role).toBe('member')
  })

  it('PATCH role with caller=admin demoting another admin returns 200', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Alice' })
    const admin1 = users.create({ name: 'Bob' })
    users.update(admin1.id, { role: 'admin' })
    const admin2 = users.create({ name: 'Charlie' })
    users.update(admin2.id, { role: 'admin' })
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'PATCH', url: `/users/${admin2.id}`, payload: { role: 'member' }, headers: hdr(db, admin1.id) })
    expect(res.statusCode).toBe(200)
    expect(res.json().role).toBe('member')
  })

  it('PATCH role with caller=admin demoting owner returns 403 role-immutable', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Alice' })
    const adminUser = users.create({ name: 'Bob' })
    users.update(adminUser.id, { role: 'admin' })
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'PATCH', url: `/users/${owner.id}`, payload: { role: 'member' }, headers: hdr(db, adminUser.id) })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('role-immutable')
  })

  it('PATCH role with caller=member trying to promote self returns 403 caller-forbidden', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    users.create({ name: 'Alice' }) // owner
    const member = users.create({ name: 'Bob' })
    const app = await buildApp(users, db)
    const res = await app.inject({ method: 'PATCH', url: `/users/${member.id}`, payload: { role: 'admin' }, headers: hdr(db, member.id) })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
  })
})

describe('PATCH /users/:id preferences', () => {
  it('merges preferences and returns combined blob', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const u = users.create({ name: 'A', preferences: { theme: 'dark', audioLanguage: 'en' } })
    const app = await buildApp(users, db)
    const res = await app.inject({
      method: 'PATCH', url: `/users/${u.id}`,
      payload: { preferences: { theme: 'light' } },
      headers: hdr(db, u.id),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().preferences).toEqual({ theme: 'light', audioLanguage: 'en' })
  })

  it('rejects unknown key in preferences (strict schema)', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const u = users.create({ name: 'A' })
    const app = await buildApp(users, db)
    const res = await app.inject({
      method: 'PATCH', url: `/users/${u.id}`,
      payload: { preferences: { theme: 'dark', foo: 'bar' } },
      headers: hdr(db, u.id),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('rejects invalid theme enum value', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const u = users.create({ name: 'A' })
    const app = await buildApp(users, db)
    const res = await app.inject({
      method: 'PATCH', url: `/users/${u.id}`,
      payload: { preferences: { theme: 'midnight' } },
      headers: hdr(db, u.id),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('rejects invalid language code', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const u = users.create({ name: 'A' })
    const app = await buildApp(users, db)
    const res = await app.inject({
      method: 'PATCH', url: `/users/${u.id}`,
      payload: { preferences: { audioLanguage: 'klingon' } },
      headers: hdr(db, u.id),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('accepts every curated language code', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const app = await buildApp(users, db)
    for (const { code } of SUPPORTED_LANGUAGES) {
      const u = users.create({ name: `user-${code}` })
      const res = await app.inject({
        method: 'PATCH', url: `/users/${u.id}`,
        payload: { preferences: { audioLanguage: code, subtitleLanguage: code } },
        headers: hdr(db, u.id),
      })
      expect(res.statusCode, `expected 200 for language code ${code}`).toBe(200)
      expect(res.json().preferences.audioLanguage).toBe(code)
      expect(res.json().preferences.subtitleLanguage).toBe(code)
    }
  })

  it('rejects wrong type for boolean field', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const u = users.create({ name: 'A' })
    const app = await buildApp(users, db)
    const res = await app.inject({
      method: 'PATCH', url: `/users/${u.id}`,
      payload: { preferences: { subtitlesEnabled: 'yes' } },
      headers: hdr(db, u.id),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('leaves existing prefs untouched when preferences key is absent', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const u = users.create({ name: 'A', preferences: { theme: 'light' } })
    const app = await buildApp(users, db)
    const res = await app.inject({
      method: 'PATCH', url: `/users/${u.id}`,
      payload: { name: 'B' },
      headers: hdr(db, u.id),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().preferences).toEqual({ theme: 'light' })
  })

  it('partial patch only overwrites supplied keys', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const u = users.create({ name: 'A', preferences: { theme: 'light', subtitlesEnabled: true, audioLanguage: 'fr' } })
    const app = await buildApp(users, db)
    const res = await app.inject({
      method: 'PATCH', url: `/users/${u.id}`,
      payload: { preferences: { theme: 'dark' } },
      headers: hdr(db, u.id),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().preferences).toEqual({ theme: 'dark', subtitlesEnabled: true, audioLanguage: 'fr' })
  })
})
