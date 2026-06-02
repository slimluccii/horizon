import { describe, it, expect } from 'vitest'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'

describe('migrate', () => {
  it('applies all migrations to an empty DB', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const ver = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(ver).toBe(6)
  })

  it('is idempotent — applying twice leaves version at the latest', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    migrate(db)
    const ver = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(ver).toBe(6)
    const rows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]
    expect(rows.map(r => r.version)).toEqual([1, 2, 3, 4, 5, 6])
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
    // v6 additions
    expect(names).toContain('sessions')
    expect(names).toContain('pairing_codes')
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
    expect(ver).toBe(6)
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

  it('v5: server_settings movies_roots/shows_roots exist after fresh migrate', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const cols = (db.prepare('PRAGMA table_info(server_settings)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toContain('movies_roots')
    expect(cols).toContain('shows_roots')
  })

  it('v5: server_settings has movies_roots/shows_roots defaulting to []', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const cols = db.prepare('PRAGMA table_info(server_settings)').all() as { name: string; dflt_value: string | null }[]
    const movies = cols.find(c => c.name === 'movies_roots')
    const shows = cols.find(c => c.name === 'shows_roots')
    expect(movies).toBeDefined()
    expect(shows).toBeDefined()
    const row = db.prepare('SELECT movies_roots, shows_roots FROM server_settings WHERE id = 1').get() as { movies_roots: string; shows_roots: string }
    expect(row.movies_roots).toBe('[]')
    expect(row.shows_roots).toBe('[]')
  })

  it('v4: server_settings table exists after migrate', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[]).map(r => r.name)
    expect(names).toContain('server_settings')
  })

  it('v4: server_settings CHECK(id=1) rejects id=2', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    expect(() => {
      db.prepare(
        `INSERT INTO server_settings (id, scan_concurrency, scan_cron_hour, watch_fs,
          watch_debounce_ms, metadata_batch_size, metadata_max_age_movie_days,
          metadata_max_age_show_days, metadata_max_age_episode_days, watched_threshold_pct,
          max_sessions, ws_grace_ms, ws_attach_ms, max_renditions, seeded_from_env, updated_at)
         VALUES (2, 4, 3, 0, 5000, 50, 30, 7, 60, 90, 4, 10000, 10000, 3, 0, 0)`,
      ).run()
    }).toThrow()
  })

  it('v4: singleton row has id=1, seeded_from_env=0, watched_threshold_pct=90 after fresh migrate', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const row = db.prepare('SELECT * FROM server_settings WHERE id = 1').get() as Record<string, number>
    expect(row).toBeDefined()
    expect(row.id).toBe(1)
    expect(row.seeded_from_env).toBe(0)
    expect(row.watched_threshold_pct).toBe(90)
  })

  it('v6: user_version is 6 after fresh migrate', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const ver = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(ver).toBe(6)
  })

  it('v6: users gains password + lockout columns', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const cols = db.prepare('PRAGMA table_info(users)').all() as { name: string; dflt_value: string | null }[]
    const byName = Object.fromEntries(cols.map(c => [c.name, c]))
    expect(byName.password_hash).toBeDefined()
    expect(byName.password_set_at).toBeDefined()
    expect(byName.failed_attempts).toBeDefined()
    expect(byName.failed_attempts.dflt_value).toBe('0')
    expect(byName.locked_until).toBeDefined()
  })

  it('v6: sessions table has expected columns + unique token_hash', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toEqual(
      expect.arrayContaining(['id', 'token_hash', 'user_id', 'created_at', 'expires_at', 'last_seen_at', 'user_agent']),
    )
    db.prepare('INSERT INTO users (id, name, avatar, preferences, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('u1', 'Alice', null, '{}', 'owner', 1000, 1000)
    db.prepare('INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('s1', 'hash1', 'u1', 0, 0, 0)
    expect(() => {
      db.prepare('INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('s2', 'hash1', 'u1', 0, 0, 0)
    }).toThrow(/UNIQUE constraint failed: sessions\.token_hash/)
  })

  it('v6: deleting a user cascades to their sessions', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    db.prepare('INSERT INTO users (id, name, avatar, preferences, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('u1', 'Alice', null, '{}', 'owner', 1000, 1000)
    db.prepare('INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('s1', 'hash1', 'u1', 0, 0, 0)
    db.prepare('DELETE FROM users WHERE id = ?').run('u1')
    const rows = db.prepare('SELECT id FROM sessions').all()
    expect(rows).toHaveLength(0)
  })

  it('v6: pairing_codes table has expected columns', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const cols = (db.prepare('PRAGMA table_info(pairing_codes)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toEqual(
      expect.arrayContaining(['code', 'created_at', 'expires_at', 'approved_user_id', 'consumed', 'session_id']),
    )
  })

  it('v6: applies onto an existing pre-v6 (v5) DB', () => {
    const db = openDatabase(':memory:')
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        avatar TEXT,
        preferences TEXT NOT NULL DEFAULT '{}',
        role TEXT NOT NULL DEFAULT 'member',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    db.exec('PRAGMA user_version = 5')
    db.prepare('INSERT INTO users (id, name, avatar, preferences, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('u1', 'Alice', null, '{}', 'owner', 1000, 1000)
    migrate(db)
    const ver = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(ver).toBe(6)
    const row = db.prepare('SELECT password_set_at, failed_attempts FROM users WHERE id = ?').get('u1') as { password_set_at: number | null; failed_attempts: number }
    expect(row.password_set_at).toBeNull()
    expect(row.failed_attempts).toBe(0)
  })
})
