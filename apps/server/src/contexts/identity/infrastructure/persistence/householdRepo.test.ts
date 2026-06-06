import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../../../platform/db/connection.ts'
import { migrate } from '../../../../platform/db/migrations.ts'
import { createHouseholdRepo, type HouseholdRepo } from './householdRepo.ts'
import { createUserRepo } from './userRepo.ts'
import { createSessionRepo } from './sessionRepo.ts'

function seedUser(db: DatabaseSync, id: string): void {
  db.prepare('INSERT INTO users (id, name, avatar, preferences, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, id, null, '{}', 'member', 1000, 1000)
}

function fresh(): { db: DatabaseSync; repo: HouseholdRepo } {
  const db = openDatabase(':memory:')
  migrate(db)
  return { db, repo: createHouseholdRepo(db) }
}

describe('householdRepo', () => {
  let db: DatabaseSync
  let repo: HouseholdRepo
  beforeEach(() => { ({ db, repo } = fresh()) })

  it('creates a household with a generated id', () => {
    const h = repo.create('Home', null)
    expect(h.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(h.name).toBe('Home')
    expect(repo.get(h.id)).toEqual(h)
  })

  it('rename updates the name', () => {
    const h = repo.create('Home', null)
    repo.rename(h.id, 'Living Room')
    expect(repo.get(h.id)?.name).toBe('Living Room')
  })

  it('setOwner records the owner', () => {
    seedUser(db, 'user-1')
    const h = repo.create('Home', null)
    repo.setOwner(h.id, 'user-1')
    expect(repo.get(h.id)?.ownerUserId).toBe('user-1')
  })

  it('get returns null for an unknown id', () => {
    expect(repo.get('nope')).toBeNull()
  })

  it('rename returns false for an unknown id', () => {
    expect(repo.rename('nope', 'X')).toBe(false)
  })

  it('setOwner returns false for an unknown id', () => {
    expect(repo.setOwner('nope', 'x')).toBe(false)
  })

  it('list() returns all households', () => {
    repo.create('A', null); repo.create('B', null)
    expect(repo.list().map(h => h.name).sort()).toEqual(['A', 'B'])
  })

  it('deleteCascade removes the household, its members, and their dependent rows', () => {
    const users = createUserRepo(db)
    const sessions = createSessionRepo(db)
    const h = repo.create('Friends', null)
    const u = users.create({ name: 'F1', householdId: h.id })
    repo.setOwner(h.id, u.id)
    sessions.issue(u.id)   // a dependent row (ON DELETE CASCADE)
    expect(repo.deleteCascade(h.id)).toBe(true)
    expect(repo.get(h.id)).toBeNull()
    expect(users.get(u.id)).toBeNull()
  })

  it('deleteCascade clears invites referencing a member (created_by) or the household (household_id)', () => {
    const users = createUserRepo(db)
    const h = repo.create('Friends', null)
    const u = users.create({ name: 'F3', householdId: h.id })
    repo.setOwner(h.id, u.id)
    // invites.created_by and invites.household_id are FK RESTRICT (no ON DELETE
    // CASCADE) — without the explicit cleanup the whole delete would roll back.
    db.prepare('INSERT INTO invites (code, kind, household_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('inv-by-member', 'join', null, u.id, 1000, 2000)
    db.prepare('INSERT INTO invites (code, kind, household_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('inv-by-household', 'join', h.id, u.id, 1000, 2000)
    expect(repo.deleteCascade(h.id)).toBe(true)
    expect(repo.get(h.id)).toBeNull()
    expect(users.get(u.id)).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS n FROM invites').get()).toEqual({ n: 0 })
  })

  it('deleteOrphaning removes the household but keeps members (household_id null)', () => {
    const users = createUserRepo(db)
    const h = repo.create('Friends', null)
    const u = users.create({ name: 'F2', householdId: h.id })
    repo.setOwner(h.id, u.id)
    expect(repo.deleteOrphaning(h.id)).toBe(true)
    expect(repo.get(h.id)).toBeNull()
    expect(users.get(u.id)?.householdId).toBeNull()
  })

  it('hasServerOwner is true when a role=owner user is in the household', () => {
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Owner' })   // first user → owner
    const h = repo.create('Home', owner.id)
    users.setHousehold(owner.id, h.id)
    expect(repo.hasServerOwner(h.id)).toBe(true)
    expect(repo.hasServerOwner(repo.create('X', null).id)).toBe(false)
  })
})
