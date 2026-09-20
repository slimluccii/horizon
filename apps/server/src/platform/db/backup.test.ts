import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase } from './connection.ts'
import { migrate } from './migrations.ts'
import { runBackup, backupDir, BACKUP_RETENTION } from './backup.ts'

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
