import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type DatabaseSync } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createUserRepo, type UserRepo } from '../src/repos/users.ts'

function freshRepo(): UserRepo {
  const db: DatabaseSync = openDatabase(':memory:')
  migrate(db)
  return createUserRepo(db)
}

describe('userRepo', () => {
  let repo: UserRepo
  beforeEach(() => { repo = freshRepo() })

  it('creates a user with generated id + timestamps', () => {
    const u = repo.create({ name: 'Luuk', avatar: '🐼' })
    expect(u.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(u.name).toBe('Luuk')
    expect(u.createdAt).toBeGreaterThan(0)
    expect(u.createdAt).toBe(u.updatedAt)
  })

  it('lists users in insertion order', () => {
    repo.create({ name: 'A' })
    repo.create({ name: 'B' })
    const list = repo.list()
    expect(list.map(u => u.name)).toEqual(['A', 'B'])
  })

  it('rejects duplicate names case-insensitively', () => {
    repo.create({ name: 'Luuk' })
    expect(() => repo.create({ name: 'luuk' })).toThrow(/name-taken/)
  })

  it('gets by id, returns null for missing', () => {
    const u = repo.create({ name: 'A' })
    expect(repo.get(u.id)?.name).toBe('A')
    expect(repo.get('missing')).toBeNull()
  })

  it('updates name and bumps updatedAt', async () => {
    const u = repo.create({ name: 'A' })
    await new Promise(r => setTimeout(r, 2))
    const u2 = repo.update(u.id, { name: 'B' })
    expect(u2!.name).toBe('B')
    expect(u2!.updatedAt).toBeGreaterThan(u.updatedAt)
  })

  it('deletes user and returns true', () => {
    const a = repo.create({ name: 'A' })
    const b = repo.create({ name: 'B' })
    expect(repo.delete(b.id)).toBe(true)
    expect(repo.get(b.id)).toBeNull()
    expect(repo.delete(b.id)).toBe(false)
    expect(repo.get(a.id)).not.toBeNull()
  })

  it('preserves preferences JSON blob across round-trip', () => {
    const u = repo.create({ name: 'A', preferences: { defaultQuality: 'auto' } })
    expect(repo.get(u.id)!.preferences).toEqual({ defaultQuality: 'auto' })
  })

  it('first create is owner', () => {
    const u = repo.create({ name: 'A' })
    expect(u.role).toBe('owner')
  })

  it('second create is member', () => {
    repo.create({ name: 'A' })
    const u = repo.create({ name: 'B' })
    expect(u.role).toBe('member')
  })

  it('delete owner throws owner-protected', () => {
    const owner = repo.create({ name: 'A' })
    let caught: unknown
    try { repo.delete(owner.id) } catch (e) { caught = e }
    expect(caught).toBeDefined()
    expect((caught as { code?: string }).code).toBe('owner-protected')
  })

  it('delete non-owner returns true', () => {
    repo.create({ name: 'A' }) // owner
    const member = repo.create({ name: 'B' })
    expect(repo.delete(member.id)).toBe(true)
  })

  it('update owner role to member throws role-immutable', () => {
    const owner = repo.create({ name: 'A' })
    let caught: unknown
    try { repo.update(owner.id, { role: 'member' }) } catch (e) { caught = e }
    expect((caught as { code?: string }).code).toBe('role-immutable')
  })

  it('update owner role to owner is a no-op', () => {
    const owner = repo.create({ name: 'A' })
    const result = repo.update(owner.id, { role: 'owner' })
    expect(result?.role).toBe('owner')
  })

  it('update owner name succeeds', () => {
    const owner = repo.create({ name: 'A' })
    const result = repo.update(owner.id, { name: 'X' })
    expect(result?.name).toBe('X')
    expect(result?.role).toBe('owner')
  })

  it('update member role to owner throws owner-exists', () => {
    repo.create({ name: 'A' }) // owner
    const member = repo.create({ name: 'B' })
    let caught: unknown
    try { repo.update(member.id, { role: 'owner' }) } catch (e) { caught = e }
    expect((caught as { code?: string }).code).toBe('owner-exists')
  })
})
