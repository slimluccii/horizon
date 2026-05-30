import { describe, it, expect } from 'vitest'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'

describe('migrate', () => {
  it('applies all migrations to an empty DB', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const ver = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(ver).toBe(4)
  })

  it('is idempotent — applying twice leaves version at the latest', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    migrate(db)
    const ver = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(ver).toBe(4)
    const rows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]
    expect(rows.map(r => r.version)).toEqual([1, 2, 3, 4])
  })

  it('creates all tables', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[]).map(r => r.name)
    expect(names).toContain('users')
    expect(names).toContain('media_items')
    expect(names).toContain('collections')
    expect(names).toContain('collection_items')
    expect(names).toContain('watch_progress')
    expect(names).toContain('schema_migrations')
    // v2 additions
    expect(names).toContain('scan_roots')
    expect(names).toContain('tmdb_changes_cursor')
    expect(names).toContain('scan_history')
    // v4 additions
    expect(names).toContain('server_settings')
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

  it('adds role column with default member to users on v3', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const cols = db.prepare('PRAGMA table_info(users)').all() as { name: string; dflt_value: string | null }[]
    const roleCol = cols.find(c => c.name === 'role')
    expect(roleCol).toBeDefined()
    expect(roleCol!.dflt_value).toBe("'member'")
  })

  it('backfills oldest user as owner on a pre-v3 DB', () => {
    const db = openDatabase(':memory:')
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        avatar TEXT,
        preferences TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    db.exec('PRAGMA user_version = 2')
    db.prepare('INSERT INTO users (id, name, avatar, preferences, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('u1', 'Alice', null, '{}', 1000, 1000)
    db.prepare('INSERT INTO users (id, name, avatar, preferences, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('u2', 'Bob', null, '{}', 2000, 2000)
    migrate(db)
    const alice = db.prepare('SELECT role FROM users WHERE id = ?').get('u1') as { role: string }
    const bob = db.prepare('SELECT role FROM users WHERE id = ?').get('u2') as { role: string }
    expect(alice.role).toBe('owner')
    expect(bob.role).toBe('member')
  })

  it('backfill is idempotent — re-running migrate does not change ownership', () => {
    const db = openDatabase(':memory:')
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        avatar TEXT,
        preferences TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    db.exec('PRAGMA user_version = 2')
    db.prepare('INSERT INTO users (id, name, avatar, preferences, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('u1', 'Alice', null, '{}', 1000, 1000)
    migrate(db)
    migrate(db)
    const ver = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(ver).toBe(4)
    const owners = db.prepare("SELECT id FROM users WHERE role = 'owner'").all() as { id: string }[]
    expect(owners).toHaveLength(1)
    expect(owners[0].id).toBe('u1')
  })

  it('enforces one-owner partial unique index', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    db.prepare('INSERT INTO users (id, name, avatar, preferences, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('u1', 'Alice', null, '{}', 'owner', 1000, 1000)
    expect(() => {
      db.prepare('INSERT INTO users (id, name, avatar, preferences, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('u2', 'Bob', null, '{}', 'owner', 2000, 2000)
    }).toThrow(/UNIQUE constraint failed: users\.role/)
  })
})
