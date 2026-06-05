import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../../../platform/db/connection.ts'
import { migrate } from '../../../../platform/db/migrations.ts'
import { createHouseholdRepo } from './householdRepo.ts'
import { createUserRepo } from './userRepo.ts'
import { createInviteRepo, type InviteRepo } from './inviteRepo.ts'

interface Fixture {
  repo: InviteRepo
  householdId: string
  userId: string
}

// invites.household_id and invites.created_by are real FKs (PRAGMA
// foreign_keys = ON), so we seed a real household + user and use their ids
// rather than placeholders.
function fresh(): Fixture {
  const db: DatabaseSync = openDatabase(':memory:')
  migrate(db)
  const household = createHouseholdRepo(db).create('Home', null)
  const user = createUserRepo(db).create({ name: 'Alice', householdId: household.id })
  return { repo: createInviteRepo(db), householdId: household.id, userId: user.id }
}

describe('inviteRepo', () => {
  let repo: InviteRepo
  let householdId: string
  let userId: string
  beforeEach(() => { ({ repo, householdId, userId } = fresh()) })

  it('creates and reads a join invite', () => {
    const now = Date.now()
    repo.create({ code: 'JOIN-1', kind: 'join', householdId, createdBy: userId, createdAt: now, expiresAt: now + 1000 })
    const inv = repo.get('JOIN-1')!
    expect(inv.kind).toBe('join')
    expect(inv.householdId).toBe(householdId)
    expect(inv.consumedAt).toBeNull()
  })

  it('consume stamps consumed_at; double-consume returns false', () => {
    const now = Date.now()
    repo.create({ code: 'NH-1', kind: 'new_household', householdId: null, createdBy: userId, createdAt: now, expiresAt: now + 1000 })
    expect(repo.consume('NH-1', now)).toBe(true)
    expect(repo.get('NH-1')?.consumedAt).toBe(now)
    expect(repo.consume('NH-1', now)).toBe(false)
  })

  it('get returns null for unknown code', () => {
    expect(repo.get('nope')).toBeNull()
  })
})
