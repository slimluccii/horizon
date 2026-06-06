import crypto from 'node:crypto'
import type { DatabaseSync } from '../../../../platform/db/connection.ts'
import { HouseholdRowSchema } from '../../../../platform/db/rowSchemas.ts'

export interface Household {
  id: string
  name: string
  ownerUserId: string | null
  createdAt: number
}

export interface HouseholdRepo {
  create(name: string, ownerUserId: string | null): Household
  get(id: string): Household | null
  rename(id: string, name: string): boolean
  setOwner(id: string, ownerUserId: string): boolean
}

function rowToHousehold(raw: unknown): Household {
  const row = HouseholdRowSchema.parse(raw)
  return { id: row.id, name: row.name, ownerUserId: row.owner_user_id, createdAt: row.created_at }
}

export function createHouseholdRepo(db: DatabaseSync): HouseholdRepo {
  return {
    create(name, ownerUserId) {
      const id = crypto.randomUUID()
      const now = Date.now()
      db.prepare('INSERT INTO households (id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
        .run(id, name, ownerUserId, now)
      return { id, name, ownerUserId, createdAt: now }
    },
    get(id) {
      const row = db.prepare('SELECT * FROM households WHERE id = ?').get(id)
      return row ? rowToHousehold(row) : null
    },
    rename(id, name) {
      return db.prepare('UPDATE households SET name = ? WHERE id = ?').run(name, id).changes > 0
    },
    setOwner(id, ownerUserId) {
      return db.prepare('UPDATE households SET owner_user_id = ? WHERE id = ?').run(ownerUserId, id).changes > 0
    },
  }
}
