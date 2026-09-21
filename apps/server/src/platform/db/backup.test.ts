import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase } from './connection.ts'
import { migrate, LATEST_SCHEMA_VERSION } from './migrations.ts'
import { runBackup, backupDir, BACKUP_RETENTION, snapshotBeforeMigrate, PRE_MIGRATION_RETENTION } from './backup.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'horizon-backup-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('runBackup', () => {
  it('writes a dated snapshot next to the DB and the snapshot is a valid DB (happy path)', async () => {
    const dbPath = path.join(dir, 'horizon.db')
    const db = openDatabase(dbPath)
    migrate(db)

    const ok = await runBackup(db, dbPath, new Date('2026-08-15T04:00:00Z'))
    expect(ok).toBe(true)
    const file = path.join(backupDir(dbPath), 'horizon-2026-08-15.db')
    expect(existsSync(file)).toBe(true)

    // The snapshot opens and carries the schema.
    const restored = openDatabase(file)
    const ver = (restored.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(ver).toBeGreaterThanOrEqual(4)
  })

  it('same-day rerun replaces the snapshot instead of failing (edge path)', async () => {
    const dbPath = path.join(dir, 'horizon.db')
    const db = openDatabase(dbPath)
    migrate(db)
    const when = new Date('2026-08-15T04:00:00Z')
    expect(await runBackup(db, dbPath, when)).toBe(true)
    expect(await runBackup(db, dbPath, when)).toBe(true)
    const files = await readdir(backupDir(dbPath))
    expect(files).toEqual(['horizon-2026-08-15.db'])
  })

  it('prunes to the newest BACKUP_RETENTION snapshots', async () => {
    const dbPath = path.join(dir, 'horizon.db')
    const db = openDatabase(dbPath)
    migrate(db)
    const bdir = backupDir(dbPath)
    await mkdir(bdir, { recursive: true })
    for (let i = 1; i <= BACKUP_RETENTION + 2; i++) {
      await writeFile(path.join(bdir, `horizon-2026-07-${String(i).padStart(2, '0')}.db`), 'x')
    }
    await runBackup(db, dbPath, new Date('2026-08-15T04:00:00Z'))
    const files = (await readdir(bdir)).sort()
    expect(files).toHaveLength(BACKUP_RETENTION)
    expect(files[files.length - 1]).toBe('horizon-2026-08-15.db')
    // Oldest were dropped.
    expect(files).not.toContain('horizon-2026-07-01.db')
    expect(files).not.toContain('horizon-2026-07-02.db')
  })

  it('no-ops for in-memory databases', async () => {
    const db = openDatabase(':memory:')
    migrate(db)
    expect(await runBackup(db, ':memory:')).toBe(false)
  })
})

describe('snapshotBeforeMigrate', () => {
  /** A database as an older release left it: fully migrated, then wound back to `version`. */
  function olderDb(dbPath: string, version: number) {
    const db = openDatabase(dbPath)
    migrate(db)
    db.exec(`PRAGMA user_version = ${version}`)
    return db
  }

  it('snapshots an existing database that is about to be migrated, named after the version it holds', () => {
    const dbPath = path.join(dir, 'horizon.db')
    const db = olderDb(dbPath, LATEST_SCHEMA_VERSION - 1)
    const file = snapshotBeforeMigrate(db, dbPath)
    expect(file).toBe(path.join(backupDir(dbPath), `horizon-pre-migration-v${LATEST_SCHEMA_VERSION - 1}.db`))
    const copy = openDatabase(file!)
    expect((copy.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(LATEST_SCHEMA_VERSION - 1)
    expect(copy.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'media_items'").get()).toEqual({ n: 1 })
  })

  it('does nothing for a new database, one that is up to date, or one in memory', () => {
    const fresh = path.join(dir, 'fresh.db')
    expect(snapshotBeforeMigrate(openDatabase(fresh), fresh)).toBeNull()

    const current = path.join(dir, 'current.db')
    const db = openDatabase(current)
    migrate(db)
    expect(snapshotBeforeMigrate(db, current)).toBeNull()

    expect(snapshotBeforeMigrate(openDatabase(':memory:'), ':memory:')).toBeNull()
    expect(existsSync(backupDir(fresh))).toBe(false)
  })

  it('keeps the newest few snapshots and leaves the nightly backups alone', async () => {
    const dbPath = path.join(dir, 'horizon.db')
    await mkdir(backupDir(dbPath), { recursive: true })
    for (let v = 1; v <= PRE_MIGRATION_RETENTION + 1; v++) {
      await writeFile(path.join(backupDir(dbPath), `horizon-pre-migration-v${v}.db`), 'x')
    }
    await writeFile(path.join(backupDir(dbPath), 'horizon-2026-08-15.db'), 'x')
    const db = olderDb(dbPath, LATEST_SCHEMA_VERSION - 1)
    snapshotBeforeMigrate(db, dbPath)

    const names = (await readdir(backupDir(dbPath))).sort()
    expect(names).toContain('horizon-2026-08-15.db')
    expect(names.filter(n => n.includes('pre-migration'))).toHaveLength(PRE_MIGRATION_RETENTION)
    expect(names).not.toContain('horizon-pre-migration-v1.db')
  })
})

describe('migrate on a database from a newer release', () => {
  it('refuses to start, because an older release cannot know what the newer schema means', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`)
    expect(() => migrate(db)).toThrow(/newer release/)
  })
})
