import type { DatabaseSync } from '../db/index.ts'

/** Per-root scan bookkeeping — feeds the dir-mtime gate. */
export interface ScanRootRow {
  rootPath: string
  lastScannedAt: number
  lastDurationMs: number
  lastSeenCount: number
}

export interface ScanRootsRepo {
  get(rootPath: string): ScanRootRow | null
  set(row: ScanRootRow): void
  list(): ScanRootRow[]
}

export function createScanRootsRepo(db: DatabaseSync): ScanRootsRepo {
  return {
    get(rootPath) {
      const row = db.prepare('SELECT * FROM scan_roots WHERE root_path = ?').get(rootPath) as any
      if (!row) return null
      return {
        rootPath: row.root_path,
        lastScannedAt: row.last_scanned_at,
        lastDurationMs: row.last_duration_ms,
        lastSeenCount: row.last_seen_count,
      }
    },
    set(row) {
      db.prepare(
        `INSERT INTO scan_roots (root_path, last_scanned_at, last_duration_ms, last_seen_count)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(root_path) DO UPDATE SET
           last_scanned_at  = excluded.last_scanned_at,
           last_duration_ms = excluded.last_duration_ms,
           last_seen_count  = excluded.last_seen_count`,
      ).run(row.rootPath, row.lastScannedAt, row.lastDurationMs, row.lastSeenCount)
    },
    list() {
      const rows = db.prepare('SELECT * FROM scan_roots ORDER BY root_path ASC').all() as any[]
      return rows.map(r => ({
        rootPath: r.root_path,
        lastScannedAt: r.last_scanned_at,
        lastDurationMs: r.last_duration_ms,
        lastSeenCount: r.last_seen_count,
      }))
    },
  }
}

/** TMDB /changes feed cursor (one row per kind). */
export interface ChangesCursorRow {
  kind: 'movie' | 'tv'
  lastWindowEnd: number
  lastFetchedAt: number
}

export interface ChangesCursorRepo {
  get(kind: 'movie' | 'tv'): ChangesCursorRow | null
  set(row: ChangesCursorRow): void
}

export function createChangesCursorRepo(db: DatabaseSync): ChangesCursorRepo {
  return {
    get(kind) {
      const row = db.prepare('SELECT * FROM tmdb_changes_cursor WHERE kind = ?').get(kind) as any
      if (!row) return null
      return { kind: row.kind, lastWindowEnd: row.last_window_end, lastFetchedAt: row.last_fetched_at }
    },
    set(row) {
      db.prepare(
        `INSERT INTO tmdb_changes_cursor (kind, last_window_end, last_fetched_at)
         VALUES (?, ?, ?)
         ON CONFLICT(kind) DO UPDATE SET
           last_window_end = excluded.last_window_end,
           last_fetched_at = excluded.last_fetched_at`,
      ).run(row.kind, row.lastWindowEnd, row.lastFetchedAt)
    },
  }
}

/** Append-only scan history. Worker prunes old rows. */
export type ScanTrigger = 'boot' | 'cron' | 'manual' | 'watcher' | 'metadata'

export interface ScanHistoryRow {
  id: number
  trigger: ScanTrigger
  scope: string                  // 'full' or subtree path
  startedAt: number
  finishedAt: number | null
  itemsSeen: number
  itemsAdded: number
  itemsRemoved: number
  metadataRefreshed: number
  errors: string[] | null
}

export interface ScanHistoryRepo {
  begin(trigger: ScanTrigger, scope: string, startedAt: number): number
  finish(id: number, opts: {
    finishedAt: number
    itemsSeen: number
    itemsAdded: number
    itemsRemoved: number
    metadataRefreshed: number
    errors: string[]
  }): void
  recent(limit: number): ScanHistoryRow[]
  prune(keep: number): number
}

export function createScanHistoryRepo(db: DatabaseSync): ScanHistoryRepo {
  return {
    begin(trigger, scope, startedAt) {
      const res = db.prepare(
        `INSERT INTO scan_history (trigger, scope, started_at)
         VALUES (?, ?, ?)`,
      ).run(trigger, scope, startedAt)
      return Number(res.lastInsertRowid)
    },
    finish(id, opts) {
      db.prepare(
        `UPDATE scan_history
            SET finished_at        = ?,
                items_seen         = ?,
                items_added        = ?,
                items_removed      = ?,
                metadata_refreshed = ?,
                errors             = ?
          WHERE id = ?`,
      ).run(
        opts.finishedAt,
        opts.itemsSeen, opts.itemsAdded, opts.itemsRemoved, opts.metadataRefreshed,
        opts.errors.length > 0 ? JSON.stringify(opts.errors) : null,
        id,
      )
    },
    recent(limit) {
      const rows = db.prepare(
        `SELECT * FROM scan_history ORDER BY started_at DESC LIMIT ?`,
      ).all(limit) as any[]
      return rows.map(r => ({
        id: r.id,
        trigger: r.trigger,
        scope: r.scope,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        itemsSeen: r.items_seen,
        itemsAdded: r.items_added,
        itemsRemoved: r.items_removed,
        metadataRefreshed: r.metadata_refreshed,
        errors: r.errors ? JSON.parse(r.errors) as string[] : null,
      }))
    },
    prune(keep) {
      const res = db.prepare(
        `DELETE FROM scan_history
          WHERE id NOT IN (SELECT id FROM scan_history ORDER BY started_at DESC LIMIT ?)`,
      ).run(keep)
      return res.changes
    },
  }
}
