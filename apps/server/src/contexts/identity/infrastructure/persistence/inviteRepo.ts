import type { DatabaseSync } from '../../../../platform/db/connection.ts'
import { InviteRowSchema } from '../../../../platform/db/rowSchemas.ts'

export type InviteKind = 'join' | 'new_household'

export interface Invite {
  code: string
  kind: InviteKind
  householdId: string | null
  createdBy: string
  createdAt: number
  expiresAt: number
  consumedAt: number | null
}

export interface InviteInsert {
  code: string
  kind: InviteKind
  householdId: string | null
  createdBy: string
  createdAt: number
  expiresAt: number
}

export interface InviteRepo {
  /** Insert a fresh invite. Throws on a primary-key collision (caller retries). */
  create(input: InviteInsert): void
  get(code: string): Invite | null
  /** Mark an invite consumed at [now]. Returns false if already consumed/unknown. */
  consume(code: string, now: number): boolean
  /** Reopen an invite this request just consumed (clear `consumed_at`) so a guest
   *  can retry after a *recoverable* redeem failure — e.g. a globally-taken name.
   *  Used only on the failure path right after a successful {@link consume}, so
   *  it never resurrects a code another request legitimately claimed. Returns
   *  false if no such code. */
  release(code: string): boolean
}

function rowToInvite(raw: unknown): Invite {
  const row = InviteRowSchema.parse(raw)
  return {
    code: row.code,
    kind: row.kind,
    householdId: row.household_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  }
}

export function createInviteRepo(db: DatabaseSync): InviteRepo {
  return {
    create(input) {
      db.prepare(
        `INSERT INTO invites (code, kind, household_id, created_by, created_at, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      ).run(input.code, input.kind, input.householdId, input.createdBy, input.createdAt, input.expiresAt)
    },
    get(code) {
      const row = db.prepare('SELECT * FROM invites WHERE code = ?').get(code)
      return row ? rowToInvite(row) : null
    },
    consume(code, now) {
      return db.prepare('UPDATE invites SET consumed_at = ? WHERE code = ? AND consumed_at IS NULL')
        .run(now, code).changes > 0
    },
    release(code) {
      return db.prepare('UPDATE invites SET consumed_at = NULL WHERE code = ?').run(code).changes > 0
    },
  }
}
