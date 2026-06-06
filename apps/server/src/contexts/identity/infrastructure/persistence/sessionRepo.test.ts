import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../../../platform/db/connection.ts'
import { migrate } from '../../../../platform/db/migrations.ts'
import { createSessionRepo, type SessionRepo } from './sessionRepo.ts'

function seedUser(db: DatabaseSync, id: string): void {
  db.prepare('INSERT INTO users (id, name, avatar, preferences, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, id, null, '{}', 'member', 1000, 1000)
}

describe('auth/session repo', () => {
  let db: DatabaseSync
  let repo: SessionRepo
  beforeEach(() => {
    db = openDatabase(':memory:')
    migrate(db)
    seedUser(db, 'u1')
    seedUser(db, 'u2')
    repo = createSessionRepo(db)
  })

  it('issues a session and resolves the raw token', () => {
    const { token, session } = repo.issue('u1', 'vitest-agent')
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/) // base64url, no padding
    expect(token.length).toBeGreaterThan(40)
    expect(session.userId).toBe('u1')
    expect(session.userAgent).toBe('vitest-agent')
    expect(session.expiresAt).toBeGreaterThan(Date.now())

    const resolved = repo.resolve(token)
    expect(resolved?.id).toBe(session.id)
    expect(resolved?.userId).toBe('u1')
  })

  it('stores only the token hash, never the raw token', () => {
    const { token } = repo.issue('u1')
    const rows = db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].token_hash).not.toBe(token)
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/) // sha256 hex
  })

  it('returns null for an unknown token', () => {
    expect(repo.resolve('nope')).toBeNull()
  })

  it('slides last_seen_at + expires_at forward on resolve', () => {
    const { token, session } = repo.issue('u1')
    // Backdate the row so the sliding bump is observable.
    db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .run(1, Date.now() + 1000, session.id)
    const resolved = repo.resolve(token)!
    expect(resolved.lastSeenAt).toBeGreaterThan(1)
    expect(resolved.expiresAt).toBeGreaterThan(Date.now() + 1000)
  })

  it('treats an expired session as a miss and deletes it', () => {
    const { token, session } = repo.issue('u1')
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 1, session.id)
    expect(repo.resolve(token)).toBeNull()
    const remaining = db.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id)
    expect(remaining).toBeUndefined()
  })

  it('revoke removes a single session', () => {
    const { token, session } = repo.issue('u1')
    expect(repo.revoke(session.id)).toBe(true)
    expect(repo.resolve(token)).toBeNull()
    expect(repo.revoke(session.id)).toBe(false) // already gone
  })

  it('revokeAllForUser removes only that user\'s sessions', () => {
    repo.issue('u1')
    repo.issue('u1')
    const { token: keep } = repo.issue('u2')
    const removed = repo.revokeAllForUser('u1')
    expect(removed).toBe(2)
    expect(repo.resolve(keep)).not.toBeNull()
  })

  it('sweepExpired deletes only past-due rows', () => {
    const { session: expired } = repo.issue('u1')
    const { token: live } = repo.issue('u2')
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 1, expired.id)
    const removed = repo.sweepExpired()
    expect(removed).toBe(1)
    expect(repo.resolve(live)).not.toBeNull()
  })

  describe('pairing codes', () => {
    it('creates, looks up, approves and consumes a code', () => {
      const now = Date.now()
      repo.createPairingCode('ABCD-1234', now, now + 60_000)
      const pc = repo.getPairingCode('ABCD-1234')!
      expect(pc.code).toBe('ABCD-1234')
      expect(pc.approvedUserId).toBeNull()
      expect(pc.consumed).toBe(false)
      expect(pc.sessionId).toBeNull()

      repo.approvePairingCode('ABCD-1234', 'u1')
      expect(repo.getPairingCode('ABCD-1234')!.approvedUserId).toBe('u1')

      const { session } = repo.issue('u1')
      repo.consumePairingCode('ABCD-1234', session.id)
      const consumed = repo.getPairingCode('ABCD-1234')!
      expect(consumed.consumed).toBe(true)
      expect(consumed.sessionId).toBe(session.id)
    })

    it('returns null for an unknown code', () => {
      expect(repo.getPairingCode('NOPE-0000')).toBeNull()
    })

    it('throws on a duplicate code (PK collision) so the caller can retry', () => {
      const now = Date.now()
      repo.createPairingCode('DUP-CODE', now, now + 60_000)
      expect(() => repo.createPairingCode('DUP-CODE', now, now + 60_000)).toThrow()
    })
  })

  describe('session grant', () => {
    it('issue stores a grant and resolve returns it', () => {
      const { token } = repo.issue('u1', null, ['u1', 'u2'])
      expect(repo.resolve(token)?.grant).toEqual(['u1', 'u2'])
    })

    it('issue without a grant defaults grant to [userId]', () => {
      const { token } = repo.issue('u1', null)
      expect(repo.resolve(token)?.grant).toEqual(['u1'])
    })

    it('issue with an EMPTY grant array normalizes to [userId] (never act-as-nobody)', () => {
      const { token, session } = repo.issue('u1', null, [])
      expect(session.grant).toEqual(['u1'])
      expect(repo.resolve(token)?.grant).toEqual(['u1'])
    })

    it('pairing approve records granted user ids; getPairingCode returns them', () => {
      // approved_user_id is a real FK → users(id); seed the approver.
      seedUser(db, 'approver')
      seedUser(db, 'partner')
      const now = Date.now()
      repo.createPairingCode('AB-12', now, now + 60_000)
      repo.approvePairingCode('AB-12', 'approver', ['approver', 'partner'])
      const pc = repo.getPairingCode('AB-12')
      expect(pc?.approvedUserId).toBe('approver')
      expect(pc?.grantedUserIds).toEqual(['approver', 'partner'])
    })

    it('consumePairingCode is atomic single-winner — a second consume returns false', () => {
      seedUser(db, 'approver')
      const now = Date.now()
      repo.createPairingCode('CD-34', now, now + 60_000)
      repo.approvePairingCode('CD-34', 'approver', ['approver'])
      const a = repo.issue('approver', null, ['approver'])
      const b = repo.issue('approver', null, ['approver'])
      expect(repo.consumePairingCode('CD-34', a.session.id)).toBe(true)
      // Second poll of the same single-use code loses — must not re-consume.
      expect(repo.consumePairingCode('CD-34', b.session.id)).toBe(false)
    })
  })
})
