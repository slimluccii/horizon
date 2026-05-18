import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createUserRepo, type UserRepo } from '../src/repos/users.ts'
import { registerUsers } from '../src/routes/users.ts'

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
    users.create({ name: 'Luuk' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'POST', url: '/users', payload: { name: 'luuk' } })
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
    users.create({ name: 'Alice' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'POST', url: '/users', payload: { name: 'Bob' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().role).toBe('member')
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
    const res = await app.inject({ method: 'PATCH', url: `/users/${u.id}`, payload: { name: 'B' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('B')
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
    const res = await app.inject({ method: 'PATCH', url: `/users/${owner.id}`, payload: { role: 'member' } })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('role-immutable')
  })

  it('PATCH member role to owner returns 409 owner-exists', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    users.create({ name: 'Alice' }) // owner
    const member = users.create({ name: 'Bob' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'PATCH', url: `/users/${member.id}`, payload: { role: 'owner' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('owner-exists')
  })
})
