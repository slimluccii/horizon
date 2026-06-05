import crypto from 'node:crypto'
import type { DatabaseSync } from '../../../../platform/db/connection.ts'

/** A server-side session row, in domain shape (token_hash never exposed). */
export interface Session {
  id: string
  userId: string
  createdAt: number
  expiresAt: number
  lastSeenAt: number
  userAgent: string | null
  /** User ids this session may act as (X-Horizon-Profile). Defaults to [userId]. */
  grant: string[]
}

/** A TV device-pairing code, in domain shape. */
export interface PairingCode {
  code: string
  createdAt: number
  expiresAt: number
  approvedUserId: string | null
  consumed: boolean
  sessionId: string | null
  grantedUserIds: string[] | null
}

export interface SessionRepo {
  /** Issue a new session for `userId`. Returns the raw token (shown once) plus
   *  the stored session. Only the SHA-256 of the token is persisted. */
  issue(userId: string, userAgent?: string | null, grant?: string[]): { token: string; session: Session }
  /** Resolve a raw token to its live session, or null if missing/expired.
   *  On a hit, bumps `last_seen_at` and slides `expires_at` forward (sliding
   *  expiry). On an expired hit, deletes the row and returns null. */
  resolve(token: string): Session | null
  /** Revoke a single session by id. Returns true if a row was removed. */
  revoke(id: string): boolean
  /** Revoke every session belonging to a user (e.g. logout-all, password reset). */
  revokeAllForUser(userId: string): number
  /** Delete all expired rows. Returns the number removed. */
  sweepExpired(): number

  // --- TV device pairing ---------------------------------------------------
  /** Insert a fresh, unapproved pairing code. Throws on a primary-key collision
   *  so the caller can retry with a new code. */
  createPairingCode(code: string, createdAt: number, expiresAt: number): void
  /** Look up a pairing code, or null if unknown. */
  getPairingCode(code: string): PairingCode | null
  /** Bind an authenticated user to a pairing code (the approval step), storing
   *  the granted user ids the minted session may act as. */
  approvePairingCode(code: string, userId: string, grantedUserIds?: string[]): void
  /** Mark a pairing code consumed and link the session it minted. */
  consumePairingCode(code: string, sessionId: string): void
}

/** Sliding session lifetime: ~90 days, bumped on every resolve. */
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000
const TOKEN_BYTES = 32

/** Hash a raw token the same way it is stored, for lookups. */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function rowToSession(row: {
  id: string
  user_id: string
  created_at: number
  expires_at: number
  last_seen_at: number
  user_agent: string | null
  grant_user_ids: string | null
}): Session {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    userAgent: row.user_agent,
    grant: row.grant_user_ids ? (JSON.parse(row.grant_user_ids) as string[]) : [row.user_id],
  }
}

export function createSessionRepo(db: DatabaseSync): SessionRepo {
  return {
    issue(userId, userAgent, grant) {
      const now = Date.now()
      const id = crypto.randomUUID()
      // base64url — URL-safe, no padding; rides cookies and Bearer headers.
      const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url')
      const tokenHash = hashToken(token)
      const expiresAt = now + SESSION_TTL_MS
      const grantJson = grant ? JSON.stringify(grant) : null
      db.prepare(
        `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, grant_user_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, tokenHash, userId, now, expiresAt, now, userAgent ?? null, grantJson)
      return {
        token,
        session: {
          id, userId, createdAt: now, expiresAt, lastSeenAt: now,
          userAgent: userAgent ?? null, grant: grant ?? [userId],
        },
      }
    },

    resolve(token) {
      const tokenHash = hashToken(token)
      const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) as
        | { id: string; user_id: string; created_at: number; expires_at: number; last_seen_at: number; user_agent: string | null; grant_user_ids: string | null }
        | undefined
      if (!row) return null
      const now = Date.now()
      if (row.expires_at <= now) {
        // Expired — drop it (cheap incremental cleanup on a resolve miss).
        db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id)
        return null
      }
      const expiresAt = now + SESSION_TTL_MS
      db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
        .run(now, expiresAt, row.id)
      return rowToSession({ ...row, last_seen_at: now, expires_at: expiresAt })
    },

    revoke(id) {
      const res = db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
      return res.changes > 0
    },

    revokeAllForUser(userId) {
      const res = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
      return res.changes
    },

    sweepExpired() {
      const res = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now())
      return res.changes
    },

    createPairingCode(code, createdAt, expiresAt) {
      // PRIMARY KEY collision throws — the auth route retries with a new code.
      db.prepare(
        'INSERT INTO pairing_codes (code, created_at, expires_at, consumed) VALUES (?, ?, ?, 0)',
      ).run(code, createdAt, expiresAt)
    },

    getPairingCode(code) {
      const row = db.prepare('SELECT * FROM pairing_codes WHERE code = ?').get(code) as
        | { code: string; created_at: number; expires_at: number; approved_user_id: string | null; consumed: number; session_id: string | null; granted_user_ids: string | null }
        | undefined
      if (!row) return null
      return {
        code: row.code,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        approvedUserId: row.approved_user_id,
        consumed: row.consumed !== 0,
        sessionId: row.session_id,
        grantedUserIds: row.granted_user_ids ? (JSON.parse(row.granted_user_ids) as string[]) : null,
      }
    },

    approvePairingCode(code, userId, grantedUserIds) {
      db.prepare('UPDATE pairing_codes SET approved_user_id = ?, granted_user_ids = ? WHERE code = ?')
        .run(userId, grantedUserIds ? JSON.stringify(grantedUserIds) : null, code)
    },

    consumePairingCode(code, sessionId) {
      db.prepare('UPDATE pairing_codes SET consumed = 1, session_id = ? WHERE code = ?').run(sessionId, code)
    },
  }
}
