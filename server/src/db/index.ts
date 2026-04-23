import DatabaseSync from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

export type DatabaseSync = InstanceType<typeof DatabaseSync>

/**
 * Open a SQLite database at `filePath` (or ':memory:'). Applies PRAGMAs we
 * want globally: foreign_keys ON, WAL journal mode for concurrent reads
 * during scans. Creates parent directories if they don't exist.
 */
export function openDatabase(filePath: string): DatabaseSync {
  if (filePath !== ':memory:') {
    mkdirSync(path.dirname(filePath), { recursive: true })
  }
  const db = new DatabaseSync(filePath)
  db.exec('PRAGMA foreign_keys = ON')
  // WAL is a no-op on :memory: but safe to call.
  db.exec('PRAGMA journal_mode = WAL')
  return db
}
