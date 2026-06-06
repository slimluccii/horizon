import type { DatabaseSync } from '../../../platform/db/connection.ts'
import { createUserRepo } from '../infrastructure/persistence/userRepo.ts'
import { createHouseholdRepo } from '../infrastructure/persistence/householdRepo.ts'

export type { Household } from '../infrastructure/persistence/householdRepo.ts'

/**
 * Idempotent boot backfill: ensure every user belongs to a household. On a DB
 * predating households (or a fresh dev DB), create a single "Home" household
 * owned by the server `owner` and move all household-less users into it. No-op
 * once everyone is assigned. Mirrors the loadIdentity / bootstrapFromEnv pattern
 * — dynamic data setup stays out of pure-DDL migrations.
 */
const BACKFILL_FLAG = 'households_backfilled'

export function ensureHouseholds(db: DatabaseSync): void {
  // One-shot: after the first backfill, null-household users are INTENTIONAL
  // orphans (e.g. from delete-household orphan-mode) and must not be swept up.
  const done = db.prepare('SELECT value FROM server_meta WHERE key = ?').get(BACKFILL_FLAG)
  if (done) return

  const users = createUserRepo(db)
  const orphanIds = (db.prepare('SELECT id FROM users WHERE household_id IS NULL').all() as { id: string }[])
    .map(r => r.id)

  if (orphanIds.length > 0) {
    const households = createHouseholdRepo(db)
    // Reuse an existing Home (e.g. partial prior run) before making a new one.
    const existing = db.prepare("SELECT id FROM households WHERE name = 'Home' LIMIT 1").get() as
      | { id: string }
      | undefined
    const ownerRow = db.prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1").get() as
      | { id: string }
      | undefined
    // Never create an ownerless Home — a household with a null owner can never be
    // renamed or invited into by a non-server-admin (every owner-gated route fails
    // closed). Prefer the server owner; absent one (corrupt/edge DB), fall back to
    // the first orphan user so the household always has a manageable owner.
    const ownerId = ownerRow?.id ?? orphanIds[0]
    const homeId = existing?.id ?? households.create('Home', ownerId).id
    for (const id of orphanIds) users.setHousehold(id, homeId)
  }

  // Mark done even when there were no orphans — a fresh install is already
  // "backfilled", so later intentional orphans are never swept.
  db.prepare('INSERT INTO server_meta (key, value) VALUES (?, ?)').run(BACKFILL_FLAG, '1')
}
