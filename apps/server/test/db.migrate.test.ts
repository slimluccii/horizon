import { describe, it, expect } from 'vitest'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'

// The schema is a single flattened baseline (v1) — this version is unreleased,
// so there are no deployed DBs to migrate. These tests assert the final schema
// applies cleanly and enforces its constraints.
describe('migrate', () => {
  it('applies the baseline schema to an empty DB (user_version = 2)', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const ver = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(ver).toBe(2)
  })

  it('is idempotent — re-running leaves version + history unchanged', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    migrate(db)
    const ver = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(ver).toBe(2)
    const rows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]
    expect(rows.map(r => r.version)).toEqual([1, 2])
  })

  it('migrates to v2 and creates server_meta', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const ver = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(ver).toBe(2)
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[]).map(r => r.name)
    expect(names).toContain('server_meta')
  })

  it('creates all tables', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[]).map(r => r.name)
    for (const t of [
      'users', 'media_items', 'collections', 'collection_items', 'watch_progress',
      'schema_migrations', 'scan_roots', 'tmdb_changes_cursor', 'scan_history',
      'server_settings', 'sessions', 'pairing_codes',
    ]) {
      expect(names, t).toContain(t)
    }
  })

  it('enforces kind CHECK on media_items', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    expect(() => {
      db.prepare(
        `INSERT INTO media_items (id, kind, title, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('x', 'song', 't', 0, 0)
    }).toThrow()
  })

  it('users.role defaults to member', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const cols = db.prepare('PRAGMA table_info(users)').all() as { name: string; dflt_value: string | null }[]
    const roleCol = cols.find(c => c.name === 'role')
    expect(roleCol).toBeDefined()
    expect(roleCol!.dflt_value).toBe("'member'")
  })

  it('enforces the one-owner partial unique index', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    db.prepare('INSERT INTO users (id, name, avatar, preferences, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('u1', 'Alice', null, '{}', 'owner', 1000, 1000)
    expect(() => {
      db.prepare('INSERT INTO users (id, name, avatar, preferences, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('u2', 'Bob', null, '{}', 'owner', 2000, 2000)
    }).toThrow(/UNIQUE constraint failed: users\.role/)
  })

  it('users has the auth columns with expected defaults', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const byName = Object.fromEntries(
      (db.prepare('PRAGMA table_info(users)').all() as { name: string; dflt_value: string | null }[])
        .map(c => [c.name, c]),
    )
    expect(byName.password_hash).toBeDefined()
    expect(byName.password_set_at).toBeDefined()
    expect(byName.failed_attempts).toBeDefined()
    expect(byName.failed_attempts.dflt_value).toBe('0')
    expect(byName.locked_until).toBeDefined()
  })

  it('server_settings: singleton row, library roots default to []', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const row = db.prepare('SELECT * FROM server_settings WHERE id = 1').get() as Record<string, unknown>
    expect(row).toBeDefined()
    expect(row.id).toBe(1)
    expect(row.seeded_from_env).toBe(0)
    expect(row.watched_threshold_pct).toBe(90)
    expect(row.movies_roots).toBe('[]')
    expect(row.shows_roots).toBe('[]')
  })

  it('server_settings CHECK(id=1) rejects a second row', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    expect(() => {
      db.prepare('INSERT INTO server_settings (id) VALUES (2)').run()
    }).toThrow()
  })

  it('sessions: unique token_hash, cascade on user delete', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    db.prepare('INSERT INTO users (id, name, avatar, preferences, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('u1', 'Alice', null, '{}', 'owner', 1000, 1000)
    db.prepare('INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('s1', 'hash1', 'u1', 0, 0, 0)
    expect(() => {
      db.prepare('INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('s2', 'hash1', 'u1', 0, 0, 0)
    }).toThrow(/UNIQUE constraint failed: sessions\.token_hash/)

    db.prepare('DELETE FROM users WHERE id = ?').run('u1')
    expect(db.prepare('SELECT id FROM sessions').all()).toHaveLength(0)
  })

  it('pairing_codes has the expected columns', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const cols = (db.prepare('PRAGMA table_info(pairing_codes)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toEqual(
      expect.arrayContaining(['code', 'created_at', 'expires_at', 'approved_user_id', 'consumed', 'session_id']),
    )
  })
})
