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
  list(): Household[]
  rename(id: string, name: string): boolean
  setOwner(id: string, ownerUserId: string): boolean
  /** True if the household contains the server `owner` (must never be deleted). */
  hasServerOwner(id: string): boolean
  /** Clear a household's owner reference (set owner_user_id = NULL). */
  clearOwner(id: string): void
  /** Delete the household AND its member users + their non-cascading dependents
   *  (invites). Returns false if the household doesn't exist. Transactional. */
  deleteCascade(id: string): boolean
  /** Delete the household, orphaning its members (household_id → null). Transactional. */
  deleteOrphaning(id: string): boolean
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
    list() {
      return (db.prepare('SELECT * FROM households ORDER BY created_at, rowid').all()).map(rowToHousehold)
    },
    rename(id, name) {
      return db.prepare('UPDATE households SET name = ? WHERE id = ?').run(name, id).changes > 0
    },
    setOwner(id, ownerUserId) {
      return db.prepare('UPDATE households SET owner_user_id = ? WHERE id = ?').run(ownerUserId, id).changes > 0
    },
    hasServerOwner(id) {
      return !!db.prepare("SELECT 1 FROM users WHERE household_id = ? AND role = 'owner' LIMIT 1").get(id)
    },
    clearOwner(id) {
      db.prepare('UPDATE households SET owner_user_id = NULL WHERE id = ?').run(id)
    },
    deleteCascade(id) {
      if (!db.prepare('SELECT 1 FROM households WHERE id = ?').get(id)) return false
      db.transaction(() => {
        const members = (db.prepare('SELECT id FROM users WHERE household_id = ?').all(id) as { id: string }[])
        for (const m of members) {
          // Break EVERY households.owner_user_id ref to this member (RESTRICT FK)
          // — a member could own a DIFFERENT household (e.g. moved between
          // households), which would otherwise FK-fail the delete and roll the
          // whole cascade back.
          db.prepare('UPDATE households SET owner_user_id = NULL WHERE owner_user_id = ?').run(m.id)
          // invites.created_by has no ON DELETE CASCADE — clear them first.
          db.prepare('DELETE FROM invites WHERE created_by = ?').run(m.id)
          // sessions / watch_progress / pairing_codes cascade on user delete.
          db.prepare('DELETE FROM users WHERE id = ?').run(m.id)
        }
        // Invites targeting this household (FK household_id, no cascade).
        db.prepare('DELETE FROM invites WHERE household_id = ?').run(id)
        db.prepare('DELETE FROM households WHERE id = ?').run(id)
      })()
      return true
    },
    deleteOrphaning(id) {
      if (!db.prepare('SELECT 1 FROM households WHERE id = ?').get(id)) return false
      db.transaction(() => {
        db.prepare('UPDATE users SET household_id = NULL WHERE household_id = ?').run(id)
        db.prepare('UPDATE households SET owner_user_id = NULL WHERE id = ?').run(id)
        db.prepare('DELETE FROM invites WHERE household_id = ?').run(id)
        db.prepare('DELETE FROM households WHERE id = ?').run(id)
      })()
      return true
    },
  }
}
