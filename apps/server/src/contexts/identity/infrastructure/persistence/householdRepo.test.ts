import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../../../platform/db/connection.ts'
import { migrate } from '../../../../platform/db/migrations.ts'
import { createHouseholdRepo, type HouseholdRepo } from './householdRepo.ts'

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
})
