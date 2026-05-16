import { describe, it, expect } from 'vitest'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'

describe('migrate', () => {
  it('applies all migrations to an empty DB', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const ver = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(ver).toBe(2)
  })

  it('is idempotent — applying twice leaves version at the latest', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    migrate(db)
    const ver = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(ver).toBe(2)
    const rows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]
    expect(rows.map(r => r.version)).toEqual([1, 2])
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
})
