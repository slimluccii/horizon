/**
 * Nightly SQLite backup. The DB is ALL of Horizon's state (users, auth,
 * settings, library, watch progress), so a corrupted file should cost a
 * restore, not a rebuild. `VACUUM INTO` produces a consistent, compacted
 * snapshot without blocking readers.
 */
import { mkdir, readdir, unlink } from 'node:fs/promises'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from './connection.ts'
import { LATEST_SCHEMA_VERSION, schemaVersion } from './migrations.ts'

export const BACKUP_RETENTION = 7
export const PRE_MIGRATION_RETENTION = 3

const BACKUP_NAME_RE = /^horizon-(\d{4}-\d{2}-\d{2})\.db$/

/** Directory holding backups: `backups/` next to the DB file. */
export function backupDir(dbPath: string): string {
  return path.join(path.dirname(dbPath), 'backups')
}

/** Write today's backup and prune to the newest BACKUP_RETENTION files.
 *  No-op for in-memory databases. Never throws — a failed backup must not
 *  take the scheduler down; it logs and returns false. */
export async function runBackup(
  db: DatabaseSync,
  dbPath: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (dbPath === ':memory:') return false
  const dir = backupDir(dbPath)
  const stamp = now.toISOString().slice(0, 10)
  const target = path.join(dir, `horizon-${stamp}.db`)
  try {
    await mkdir(dir, { recursive: true })
    // Re-running on the same day: VACUUM INTO refuses to overwrite, so drop
    // today's file first (a same-day retry should refresh the snapshot).
    await unlink(target).catch(() => {})
    // SQL string interpolation is safe here: `target` derives entirely from
    // the operator-controlled dbPath + a date stamp. Escape quotes anyway.
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`)
    await pruneOldBackups(dir)
    console.log(`DB backup written: ${target}`)
    return true
  } catch (err) {
    console.error(`DB backup failed (${target}):`, err)
    return false
  }
}

const PRE_MIGRATION_NAME_RE = /^horizon-pre-migration-v(\d+)\.db$/

/**
 * Snapshot an existing database right before a release migrates it, named after
 * the schema version it holds. Migrations have no downgrade path, so this file
 * is the way back to the previous release. Synchronous, because it has to be
 * done before migrate() runs at boot. Returns the snapshot path, or null when
 * there is nothing to protect (new, up to date or in-memory database).
 */
export function snapshotBeforeMigrate(db: DatabaseSync, dbPath: string): string | null {
  const current = schemaVersion(db)
  if (dbPath === ':memory:' || current === 0 || current >= LATEST_SCHEMA_VERSION) return null
  const dir = backupDir(dbPath)
  const target = path.join(dir, `horizon-pre-migration-v${current}.db`)
  mkdirSync(dir, { recursive: true })
  rmSync(target, { force: true })
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`)
  const older = readdirSync(dir)
    .map(name => ({ name, version: Number(PRE_MIGRATION_NAME_RE.exec(name)?.[1]) }))
    .filter(f => Number.isFinite(f.version))
    .sort((a, b) => b.version - a.version)
    .slice(PRE_MIGRATION_RETENTION)
  for (const f of older) rmSync(path.join(dir, f.name), { force: true })
  console.log(`DB snapshot before migrating from v${current}: ${target}`)
  return target
}

async function pruneOldBackups(dir: string): Promise<void> {
  const entries = (await readdir(dir))
    .filter(name => BACKUP_NAME_RE.test(name))
    .sort()             // ISO date stamps sort chronologically
    .reverse()          // newest first
  for (const name of entries.slice(BACKUP_RETENTION)) {
    await unlink(path.join(dir, name)).catch(() => {})
  }
}
