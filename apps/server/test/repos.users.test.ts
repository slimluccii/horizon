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
    const u = repo.create({ name: 'A' })
    expect(repo.delete(u.id)).toBe(true)
    expect(repo.get(u.id)).toBeNull()
    expect(repo.delete(u.id)).toBe(false)
  })

  it('preserves preferences JSON blob across round-trip', () => {
    const u = repo.create({ name: 'A', preferences: { defaultQuality: 'auto' } })
    expect(repo.get(u.id)!.preferences).toEqual({ defaultQuality: 'auto' })
  })
})
