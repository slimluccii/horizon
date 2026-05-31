import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createUserRepo, type UserRepo } from '../src/repos/users.ts'
import { registerUsers } from '../src/routes/users.ts'
import { SUPPORTED_LANGUAGES } from '@horizon/sdk/preferences'

async function buildApp(users: UserRepo) {
  const app = Fastify({ logger: false })
  registerUsers(app, users)
  await app.ready()
  return app
}

describe('POST /users', () => {
  it('creates a user', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const app = await buildApp(users)
    const res = await app.inject({ method: 'POST', url: '/users', payload: { name: 'Luuk' } })
    expect(res.statusCode).toBe(200)
    const body = res.json() as any
    expect(body.name).toBe('Luuk')
  })

  it('rejects missing name', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const app = await buildApp(users)
    const res = await app.inject({ method: 'POST', url: '/users', payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('409 on duplicate name', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Luuk' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'POST', url: '/users', payload: { name: 'luuk' }, headers: { 'x-horizon-user': owner.id } })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('name-taken')
  })

  it('first POST returns role owner', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const app = await buildApp(users)
    const res = await app.inject({ method: 'POST', url: '/users', payload: { name: 'Alice' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().role).toBe('owner')
  })

  it('second POST returns role member', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Alice' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'POST', url: '/users', payload: { name: 'Bob' }, headers: { 'x-horizon-user': owner.id } })
    expect(res.statusCode).toBe(200)
    expect(res.json().role).toBe('member')
  })

  it('rejects unauthenticated creation when users exist', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    users.create({ name: 'Alice' }) // owner
    const app = await buildApp(users)
    const res = await app.inject({ method: 'POST', url: '/users', payload: { name: 'Bob' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('no-user')
  })

  it('rejects member-authenticated creation when users exist', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    users.create({ name: 'Alice' }) // owner
    const member = users.create({ name: 'Bob' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'POST', url: '/users', payload: { name: 'Carol' }, headers: { 'x-horizon-user': member.id } })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
  })

  it('allows unauthenticated creation on empty database', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const app = await buildApp(users)
    const res = await app.inject({ method: 'POST', url: '/users', payload: { name: 'Alice' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().role).toBe('owner')
  })
})

describe('GET /users and /users/:id', () => {
  it('lists users', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    users.create({ name: 'A' })
    const app = await buildApp(users)
    const list = await app.inject({ method: 'GET', url: '/users' })
    expect(list.json()).toHaveLength(1)
  })

  it('gets single user', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const u = users.create({ name: 'A' })
    const app = await buildApp(users)
    const one = await app.inject({ method: 'GET', url: `/users/${u.id}` })
    expect(one.json().id).toBe(u.id)
  })

  it('404 for missing user', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const app = await buildApp(users)
    const missing = await app.inject({ method: 'GET', url: '/users/missing' })
    expect(missing.statusCode).toBe(404)
  })
})

describe('PATCH + DELETE /users/:id', () => {
  it('patches name', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const u = users.create({ name: 'A' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'PATCH', url: `/users/${u.id}`, payload: { name: 'B' }, headers: { 'x-horizon-user': u.id } })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('B')
  })

  it('PATCH own profile name as member returns 200', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    users.create({ name: 'Alice' }) // owner
    const member = users.create({ name: 'Bob' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'PATCH', url: `/users/${member.id}`, payload: { name: 'Bobby' }, headers: { 'x-horizon-user': member.id } })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('Bobby')
  })

  it('PATCH own profile preferences as member returns 200', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    users.create({ name: 'Alice' }) // owner
    const member = users.create({ name: 'Bob' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'PATCH', url: `/users/${member.id}`, payload: { preferences: { theme: 'dark' } }, headers: { 'x-horizon-user': member.id } })
    expect(res.statusCode).toBe(200)
    expect(res.json().preferences).toEqual({ theme: 'dark' })
  })

  it('PATCH other user profile name as member returns 403 (IDOR closed)', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Alice' })
    const member = users.create({ name: 'Bob' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'PATCH', url: `/users/${owner.id}`, payload: { name: 'Mallory' }, headers: { 'x-horizon-user': member.id } })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
  })

  it('PATCH other user profile preferences as member returns 403 (IDOR closed)', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Alice' })
    const member = users.create({ name: 'Bob' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'PATCH', url: `/users/${owner.id}`, payload: { preferences: { theme: 'dark' } }, headers: { 'x-horizon-user': member.id } })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
  })

  it('PATCH other user profile name as owner returns 403 (self-edit only)', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Alice' })
    const member = users.create({ name: 'Bob' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'PATCH', url: `/users/${member.id}`, payload: { name: 'Robert' }, headers: { 'x-horizon-user': owner.id } })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
  })

  it('PATCH profile without x-horizon-user header returns 400 no-user', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const u = users.create({ name: 'A' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'PATCH', url: `/users/${u.id}`, payload: { name: 'B' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('no-user')
  })

  it('deletes + subsequent 404', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    users.create({ name: 'A' }) // owner
    const b = users.create({ name: 'B' }) // member
    const app = await buildApp(users)
    const del = await app.inject({ method: 'DELETE', url: `/users/${b.id}` })
    expect(del.statusCode).toBe(204)
    const get = await app.inject({ method: 'GET', url: `/users/${b.id}` })
    expect(get.statusCode).toBe(404)
  })

  it('DELETE owner returns 403 owner-protected', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Alice' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'DELETE', url: `/users/${owner.id}` })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('owner-protected')
  })

  it('PATCH owner role to member returns 403 role-immutable', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Alice' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'PATCH', url: `/users/${owner.id}`, payload: { role: 'member' }, headers: { 'x-horizon-user': owner.id } })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('role-immutable')
  })

  it('PATCH member role to owner returns 409 owner-exists', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Alice' })
    const member = users.create({ name: 'Bob' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'PATCH', url: `/users/${member.id}`, payload: { role: 'owner' }, headers: { 'x-horizon-user': owner.id } })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('owner-exists')
  })

  it('PATCH role without x-horizon-user header returns 400 no-user', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Alice' })
    const member = users.create({ name: 'Bob' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'PATCH', url: `/users/${member.id}`, payload: { role: 'admin' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('no-user')
  })

  it('PATCH role with caller role=member returns 403 caller-forbidden', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    users.create({ name: 'Alice' }) // owner
    const member = users.create({ name: 'Bob' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'PATCH', url: `/users/${member.id}`, payload: { role: 'admin' }, headers: { 'x-horizon-user': member.id } })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
  })

  it('PATCH role with caller=owner demoting admin returns 200', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Alice' })
    const adminUser = users.create({ name: 'Bob' })
    users.update(adminUser.id, { role: 'admin' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'PATCH', url: `/users/${adminUser.id}`, payload: { role: 'member' }, headers: { 'x-horizon-user': owner.id } })
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
    const app = await buildApp(users)
    const res = await app.inject({ method: 'PATCH', url: `/users/${admin2.id}`, payload: { role: 'member' }, headers: { 'x-horizon-user': admin1.id } })
    expect(res.statusCode).toBe(200)
    expect(res.json().role).toBe('member')
  })

  it('PATCH role with caller=admin demoting owner returns 403 role-immutable', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Alice' })
    const adminUser = users.create({ name: 'Bob' })
    users.update(adminUser.id, { role: 'admin' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'PATCH', url: `/users/${owner.id}`, payload: { role: 'member' }, headers: { 'x-horizon-user': adminUser.id } })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('role-immutable')
  })

  it('PATCH role with caller=member trying to promote self returns 403 caller-forbidden', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    users.create({ name: 'Alice' }) // owner
    const member = users.create({ name: 'Bob' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'PATCH', url: `/users/${member.id}`, payload: { role: 'admin' }, headers: { 'x-horizon-user': member.id } })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
  })
})

describe('PATCH /users/:id preferences', () => {
  it('merges preferences and returns combined blob', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const u = users.create({ name: 'A', preferences: { theme: 'dark', audioLanguage: 'en' } })
    const app = await buildApp(users)
    const res = await app.inject({
      method: 'PATCH', url: `/users/${u.id}`,
      payload: { preferences: { theme: 'light' } },
      headers: { 'x-horizon-user': u.id },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().preferences).toEqual({ theme: 'light', audioLanguage: 'en' })
  })

  it('rejects unknown key in preferences (strict schema)', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const u = users.create({ name: 'A' })
    const app = await buildApp(users)
    const res = await app.inject({
      method: 'PATCH', url: `/users/${u.id}`,
      payload: { preferences: { theme: 'dark', foo: 'bar' } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('rejects invalid theme enum value', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const u = users.create({ name: 'A' })
    const app = await buildApp(users)
    const res = await app.inject({
      method: 'PATCH', url: `/users/${u.id}`,
      payload: { preferences: { theme: 'midnight' } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('rejects invalid language code', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const u = users.create({ name: 'A' })
    const app = await buildApp(users)
    const res = await app.inject({
      method: 'PATCH', url: `/users/${u.id}`,
      payload: { preferences: { audioLanguage: 'klingon' } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('accepts every curated language code', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const app = await buildApp(users)
    for (const { code } of SUPPORTED_LANGUAGES) {
      const u = users.create({ name: `user-${code}` })
      const res = await app.inject({
        method: 'PATCH', url: `/users/${u.id}`,
        payload: { preferences: { audioLanguage: code, subtitleLanguage: code } },
        headers: { 'x-horizon-user': u.id },
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
    const app = await buildApp(users)
    const res = await app.inject({
      method: 'PATCH', url: `/users/${u.id}`,
      payload: { preferences: { subtitlesEnabled: 'yes' } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('leaves existing prefs untouched when preferences key is absent', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const u = users.create({ name: 'A', preferences: { theme: 'light' } })
    const app = await buildApp(users)
    const res = await app.inject({
      method: 'PATCH', url: `/users/${u.id}`,
      payload: { name: 'B' },
      headers: { 'x-horizon-user': u.id },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().preferences).toEqual({ theme: 'light' })
  })

  it('partial patch only overwrites supplied keys', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const u = users.create({ name: 'A', preferences: { theme: 'light', subtitlesEnabled: true, audioLanguage: 'fr' } })
    const app = await buildApp(users)
    const res = await app.inject({
      method: 'PATCH', url: `/users/${u.id}`,
      payload: { preferences: { theme: 'dark' } },
      headers: { 'x-horizon-user': u.id },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().preferences).toEqual({ theme: 'dark', subtitlesEnabled: true, audioLanguage: 'fr' })
  })
})
