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
    users.create({ name: 'Luuk' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'POST', url: '/users', payload: { name: 'luuk' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('name-taken')
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
    const u = users.create({ name: 'A' })
    const app = await buildApp(users)
    const del = await app.inject({ method: 'DELETE', url: `/users/${u.id}` })
    expect(del.statusCode).toBe(204)
    const get = await app.inject({ method: 'GET', url: `/users/${u.id}` })
    expect(get.statusCode).toBe(404)
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
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().preferences).toEqual({ theme: 'dark', subtitlesEnabled: true, audioLanguage: 'fr' })
  })
})
