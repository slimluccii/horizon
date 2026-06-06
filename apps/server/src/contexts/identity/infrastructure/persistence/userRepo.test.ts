import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../../../platform/db/connection.ts'
import { migrate } from '../../../../platform/db/migrations.ts'
import { createUserRepo, type UserRepo } from './userRepo.ts'
import { createHouseholdRepo } from './householdRepo.ts'

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

  it('first user in concurrent creates is owner, others are members', async () => {
    // better-sqlite3 is synchronous, so Promise.all serialises these creates;
    // the transaction in create() guarantees the COUNT+INSERT stay atomic so
    // exactly one owner is elected regardless of interleaving.
    const results = await Promise.all([
      Promise.resolve().then(() => repo.create({ name: 'A' })),
      Promise.resolve().then(() => repo.create({ name: 'B' })),
    ])
    expect(results).toHaveLength(2)
    const owners = repo.list().filter(u => u.role === 'owner')
    expect(owners).toHaveLength(1)
    const members = repo.list().filter(u => u.role === 'member')
    expect(members).toHaveLength(1)
  })

  it('new users have no password (hasPassword false, passwordSetAt null)', () => {
    const u = repo.create({ name: 'A' })
    expect(u.hasPassword).toBe(false)
    expect(u.passwordSetAt).toBeNull()
  })

  it('setPassword stamps the hash + passwordSetAt and flips hasPassword', () => {
    const u = repo.create({ name: 'A' })
    expect(repo.setPassword(u.id, '$argon2id$hash')).toBe(true)
    const after = repo.get(u.id)!
    expect(after.hasPassword).toBe(true)
    expect(after.passwordSetAt).toBeGreaterThan(0)
    const auth = repo.getAuthById(u.id)!
    expect(auth.passwordHash).toBe('$argon2id$hash')
  })

  it('setPassword on a missing user returns false', () => {
    expect(repo.setPassword('ghost', 'x')).toBe(false)
  })

  it('getAuthByName resolves case-insensitively, null on miss', () => {
    const u = repo.create({ name: 'Alice' })
    expect(repo.getAuthByName('alice')!.id).toBe(u.id)
    expect(repo.getAuthByName('nobody')).toBeNull()
  })

  it('recordFailedLogin increments the counter and sets the lockout deadline', () => {
    const u = repo.create({ name: 'A' })
    expect(repo.recordFailedLogin(u.id, null)).toBe(1)
    expect(repo.recordFailedLogin(u.id, 5000)).toBe(2)
    expect(repo.getAuthById(u.id)!.lockedUntil).toBe(5000)
  })

  it('clearLockout resets failed attempts + lockout', () => {
    const u = repo.create({ name: 'A' })
    repo.recordFailedLogin(u.id, 5000)
    repo.clearLockout(u.id)
    const auth = repo.getAuthById(u.id)!
    expect(auth.failedAttempts).toBe(0)
    expect(auth.lockedUntil).toBeNull()
  })

  it('setPassword clears any prior lockout state', () => {
    const u = repo.create({ name: 'A' })
    repo.recordFailedLogin(u.id, 5000)
    repo.setPassword(u.id, '$argon2id$hash')
    const auth = repo.getAuthById(u.id)!
    expect(auth.failedAttempts).toBe(0)
    expect(auth.lockedUntil).toBeNull()
  })

  it('transaction rollback on name conflict leaves DB clean', () => {
    repo.create({ name: 'A' }) // owner
    expect(() => repo.create({ name: 'a' })).toThrow(/name-taken/)
    // Rollback must leave no partial row and a usable connection for the next
    // create (no dangling open transaction).
    expect(repo.list()).toHaveLength(1)
    const next = repo.create({ name: 'B' })
    expect(next.role).toBe('member')
    expect(repo.list()).toHaveLength(2)
  })

  it('listOrphans returns only users with no household', () => {
    // users.household_id has a FK to households(id); seed a real household on
    // the SAME db so the assigned user satisfies the FK.
    const db: DatabaseSync = openDatabase(':memory:')
    migrate(db)
    const repo = createUserRepo(db)
    const households = createHouseholdRepo(db)
    const h = households.create('H', null).id
    const a = repo.create({ name: 'Assigned', householdId: h })
    const o1 = repo.create({ name: 'Orphan1' })   // no household
    const o2 = repo.create({ name: 'Orphan2' })
    const ids = repo.listOrphans().map(u => u.id).sort()
    expect(ids).toEqual([o1.id, o2.id].sort())
    expect(ids).not.toContain(a.id)
  })

  it('assigns and reads household_id; lists by household', () => {
    // users.household_id has a FK to households(id) and PRAGMA foreign_keys = ON
    // is global, so seed real households (via createHouseholdRepo) on the SAME db
    // before assigning users — fake ids would raise a FK violation.
    const db: DatabaseSync = openDatabase(':memory:')
    migrate(db)
    const repo = createUserRepo(db)
    const households = createHouseholdRepo(db)
    const h1 = households.create('H1', null).id
    const h2 = households.create('H2', null).id

    const a = repo.create({ name: 'A', householdId: h1 })
    const b = repo.create({ name: 'B', householdId: h1 })
    repo.create({ name: 'C', householdId: h2 })
    expect(a.householdId).toBe(h1)
    expect(repo.listByHousehold(h1).map(u => u.name).sort()).toEqual(['A', 'B'])
    repo.setHousehold(b.id, h2)
    expect(repo.get(b.id)?.householdId).toBe(h2)
    expect(repo.listByHousehold(h1).map(u => u.name)).toEqual(['A'])
  })
})
