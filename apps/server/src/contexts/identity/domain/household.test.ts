import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../../platform/db/connection.ts'
import { migrate } from '../../../platform/db/migrations.ts'
import { createUserRepo } from '../infrastructure/persistence/userRepo.ts'
import { createHouseholdRepo } from '../infrastructure/persistence/householdRepo.ts'
import { ensureHouseholds } from './household.ts'

function fresh(): DatabaseSync {
  const db = openDatabase(':memory:')
  migrate(db)
  return db
}

describe('ensureHouseholds', () => {
  let db: DatabaseSync
  beforeEach(() => { db = fresh() })

  it('assigns household-less users to a single Home household owned by the owner', () => {
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Owner' })           // create() auto-elects first user owner
    users.create({ name: 'Member' })
    ensureHouseholds(db)
    const refreshedOwner = users.get(owner.id)!
    expect(refreshedOwner.householdId).not.toBeNull()
    const households = createHouseholdRepo(db)
    const home = households.get(refreshedOwner.householdId!)!
    expect(home.name).toBe('Home')
    expect(home.ownerUserId).toBe(owner.id)
    // every user landed in the same household
    expect(new Set(users.list().map(u => u.householdId)).size).toBe(1)
  })

  it('is idempotent — a second run creates no new household', () => {
    const users = createUserRepo(db)
    users.create({ name: 'Owner' })
    ensureHouseholds(db)
    ensureHouseholds(db)
    const count = (db.prepare('SELECT COUNT(*) c FROM households').get() as { c: number }).c
    expect(count).toBe(1)
  })

  it('no-op on an empty user table', () => {
    ensureHouseholds(db)
    expect((db.prepare('SELECT COUNT(*) c FROM households').get() as { c: number }).c).toBe(0)
  })
})
