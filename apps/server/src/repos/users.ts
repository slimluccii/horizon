import crypto from 'node:crypto'
import { ErrorCodes } from '@horizon/sdk'
import type { DatabaseSync } from '../db/index.ts'
import { UserRowSchema } from '../db/rowSchemas.ts'

export interface User {
  id: string
  name: string
  avatar: string | null
  preferences: Record<string, unknown>
  role: 'owner' | 'admin' | 'member'
  createdAt: number
  updatedAt: number
}

export interface UserInsert {
  name: string
  avatar?: string | null
  preferences?: Record<string, unknown>
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
}

function rowToUser(raw: unknown): User {
  const row = UserRowSchema.parse(raw)
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    preferences: JSON.parse(row.preferences) as Record<string, unknown>,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
          `INSERT INTO users (id, name, avatar, preferences, role, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, input.name, input.avatar ?? null, prefsJson, role, now, now)
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
  }
}
