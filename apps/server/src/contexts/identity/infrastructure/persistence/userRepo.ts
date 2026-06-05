import crypto from 'node:crypto'
import { ErrorCodes } from '@horizon/sdk'
import type { DatabaseSync } from '../../../../platform/db/connection.ts'
import { UserRowSchema } from '../../../../platform/db/rowSchemas.ts'

export interface User {
  id: string
  name: string
  avatar: string | null
  preferences: Record<string, unknown>
  role: 'owner' | 'admin' | 'member'
  /** Derived: whether `password_hash` is set. The hash itself never leaves the
   *  repo — only this boolean is exposed on the wire-safe User shape. */
  hasPassword: boolean
  /** When the user last set a password (ms epoch), or null if never set. A null
   *  value flags a forced first-boot set-password (migrated owner / new member). */
  passwordSetAt: number | null
  householdId: string | null
  createdAt: number
  updatedAt: number
}

/**
 * Authentication-relevant fields for the login path. Kept separate from the
 * wire-safe {@link User} so the password hash + lockout bookkeeping never leak
 * to a route handler that serializes a User directly. Returned only by
 * `getAuthById` / `getAuthByName`.
 */
export interface UserAuth {
  id: string
  name: string
  role: 'owner' | 'admin' | 'member'
  passwordHash: string | null
  passwordSetAt: number | null
  failedAttempts: number
  lockedUntil: number | null
}

export interface UserInsert {
  name: string
  avatar?: string | null
  preferences?: Record<string, unknown>
  householdId?: string | null
}

export interface UserPatch {
  name?: string
  avatar?: string | null
  preferences?: Record<string, unknown>
  role?: 'owner' | 'admin' | 'member'
}

export interface UserRepo {
  create(input: UserInsert): User
  list(): User[]
  get(id: string): User | null
  update(id: string, patch: UserPatch): User | null
  delete(id: string): boolean
  /** Auth fields by id, or null if no such user. Internal — never serialized. */
  getAuthById(id: string): UserAuth | null
  /** Auth fields by case-insensitive name, or null. Used by the login path; the
   *  generic-error contract means callers must not reveal whether the miss was
   *  a bad name or a bad password. */
  getAuthByName(name: string): UserAuth | null
  /** Set (or reset) a user's password hash, stamp `password_set_at`, and clear
   *  any lockout/failed-attempt state. Returns false if no such user. */
  setPassword(id: string, passwordHash: string): boolean
  /** Record a failed login: bump `failed_attempts` and, once past the threshold,
   *  set `locked_until` to `now + lockMs`. Returns the new failed-attempt count. */
  recordFailedLogin(id: string, lockedUntil: number | null): number
  /** Clear failed-attempt count + lockout after a successful login. */
  clearLockout(id: string): void
  /** Owner-lockout escape hatch: clear the owner's `password_hash`,
   *  `password_set_at`, `failed_attempts`, and `locked_until` so the owner is
   *  forced back through the set-password flow (like first boot). Returns the
   *  owner's name if a reset happened, or null if there is no owner row. */
  resetOwnerPassword(): string | null
  /** Users in a household, in insertion order. */
  listByHousehold(householdId: string): User[]
  /** Move a user into a household. Returns false if no such user. */
  setHousehold(id: string, householdId: string): boolean
}

function rowToUser(raw: unknown): User {
  const row = UserRowSchema.parse(raw)
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    preferences: JSON.parse(row.preferences) as Record<string, unknown>,
    role: row.role,
    hasPassword: row.password_hash != null,
    passwordSetAt: row.password_set_at,
    householdId: row.household_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToUserAuth(raw: unknown): UserAuth {
  const row = UserRowSchema.parse(raw)
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    passwordHash: row.password_hash,
    passwordSetAt: row.password_set_at,
    failedAttempts: row.failed_attempts,
    lockedUntil: row.locked_until,
  }
}

/** Is the supplied name already used (case-insensitive, excluding optional id)? */
function nameTaken(db: DatabaseSync, name: string, excludingId?: string): boolean {
  if (excludingId) {
    const row = db.prepare(
      'SELECT 1 FROM users WHERE lower(name) = lower(?) AND id != ? LIMIT 1',
    ).get(name, excludingId)
    return !!row
  }
  const row = db.prepare('SELECT 1 FROM users WHERE lower(name) = lower(?) LIMIT 1').get(name)
  return !!row
}

export function createUserRepo(db: DatabaseSync): UserRepo {
  return {
    create(input) {
      const now = Date.now()
      const id = crypto.randomUUID()
      const prefsJson = JSON.stringify(input.preferences ?? {})
      // Wrap the name-uniqueness check, owner election (COUNT), and INSERT in a
      // single transaction so they are atomic. Without it, two concurrent
      // creates could both see COUNT=0 and race to insert an owner; the
      // partial unique index would then reject the loser with a raw constraint
      // error. Inside the transaction the COUNT and INSERT cannot interleave,
      // so the owner-exists constraint can never fire during normal operation.
      db.exec('BEGIN')
      try {
        if (nameTaken(db, input.name)) {
          throw Object.assign(new Error(ErrorCodes.NAME_TAKEN), { code: ErrorCodes.NAME_TAKEN })
        }
        const isFirst = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n === 0
        const role = isFirst ? 'owner' : 'member'
        db.prepare(
          `INSERT INTO users (id, name, avatar, preferences, role, household_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, input.name, input.avatar ?? null, prefsJson, role, input.householdId ?? null, now, now)
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
      return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id))
    },

    list() {
      const rows = db.prepare('SELECT * FROM users ORDER BY created_at ASC').all()
      return rows.map(rowToUser)
    },

    listByHousehold(householdId) {
      const rows = db.prepare('SELECT * FROM users WHERE household_id = ? ORDER BY created_at, rowid').all(householdId)
      return rows.map(rowToUser)
    },

    setHousehold(id, householdId) {
      return db.prepare('UPDATE users SET household_id = ?, updated_at = ? WHERE id = ?')
        .run(householdId, Date.now(), id).changes > 0
    },

    get(id) {
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id)
      return row ? rowToUser(row) : null
    },

    update(id, patch) {
      const existing = this.get(id)
      if (!existing) return null
      if (patch.name && nameTaken(db, patch.name, id)) {
        throw Object.assign(new Error(ErrorCodes.NAME_TAKEN), { code: ErrorCodes.NAME_TAKEN })
      }
      if (patch.role !== undefined && existing.role === 'owner' && patch.role !== 'owner') {
        throw Object.assign(new Error(ErrorCodes.ROLE_IMMUTABLE), { code: ErrorCodes.ROLE_IMMUTABLE })
      }
      const next = {
        name: patch.name ?? existing.name,
        avatar: patch.avatar !== undefined ? patch.avatar : existing.avatar,
        preferences: patch.preferences ?? existing.preferences,
      }
      try {
        db.prepare(
          `UPDATE users
             SET name = ?, avatar = ?, preferences = ?, role = COALESCE(?, role), updated_at = ?
           WHERE id = ?`,
        ).run(next.name, next.avatar, JSON.stringify(next.preferences), patch.role ?? null, Date.now(), id)
      } catch (err) {
        if (String((err as Error).message).includes('users.role')) {
          throw Object.assign(new Error(ErrorCodes.OWNER_EXISTS), { code: ErrorCodes.OWNER_EXISTS })
        }
        throw err
      }
      return this.get(id)
    },

    delete(id) {
      const existing = this.get(id)
      if (!existing) return false
      if (existing.role === 'owner') {
        throw Object.assign(new Error(ErrorCodes.OWNER_PROTECTED), { code: ErrorCodes.OWNER_PROTECTED })
      }
      const res = db.prepare('DELETE FROM users WHERE id = ?').run(id)
      return res.changes > 0
    },

    getAuthById(id) {
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id)
      return row ? rowToUserAuth(row) : null
    },

    getAuthByName(name) {
      // Case-insensitive to match the unique-name contract enforced on create.
      const row = db.prepare('SELECT * FROM users WHERE lower(name) = lower(?) LIMIT 1').get(name)
      return row ? rowToUserAuth(row) : null
    },

    setPassword(id, passwordHash) {
      const now = Date.now()
      const res = db.prepare(
        `UPDATE users
            SET password_hash = ?, password_set_at = ?, failed_attempts = 0, locked_until = NULL,
                updated_at = ?
          WHERE id = ?`,
      ).run(passwordHash, now, now, id)
      return res.changes > 0
    },

    recordFailedLogin(id, lockedUntil) {
      // Atomic increment so concurrent failed logins can't lose a count.
      db.prepare('UPDATE users SET failed_attempts = failed_attempts + 1, locked_until = ? WHERE id = ?')
        .run(lockedUntil, id)
      const row = db.prepare('SELECT failed_attempts FROM users WHERE id = ?').get(id) as
        | { failed_attempts: number }
        | undefined
      return row?.failed_attempts ?? 0
    },

    clearLockout(id) {
      db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(id)
    },

    resetOwnerPassword() {
      // Single owner per DB (idx_users_one_owner). Wipe the credential + lockout
      // bookkeeping in one statement and report which user was reset for the
      // boot-time audit log.
      const owner = db.prepare("SELECT id, name FROM users WHERE role = 'owner' LIMIT 1").get() as
        | { id: string; name: string }
        | undefined
      if (!owner) return null
      db.prepare(
        `UPDATE users
            SET password_hash = NULL, password_set_at = NULL, failed_attempts = 0,
                locked_until = NULL, updated_at = ?
          WHERE id = ?`,
      ).run(Date.now(), owner.id)
      return owner.name
    },
  }
}
