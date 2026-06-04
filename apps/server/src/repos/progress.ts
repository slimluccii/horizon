import type { DatabaseSync } from '../db/index.ts'
import type { MediaItem, MediaRepo } from '../contexts/library/index.ts'

export interface WatchProgress {
  mediaId: string
  positionMs: number
  durationMs: number
  watched: boolean
  updatedAt: number
}

export interface ContinueWatchingItem {
  mediaId: string
  kind: 'movie' | 'episode'
  positionMs: number
  durationMs: number
  percent: number
  updatedAt: number
  media: MediaItem
  show?: MediaItem
}

export interface ProgressInput {
  positionMs: number
  durationMs: number
}

export interface ProgressRepoOpts {
  getWatchedThresholdPct: () => number
}

/** Last 30 s of a title always counts as watched (credits buffer). */
const WATCHED_TAIL_MS = 30_000

export interface ProgressRepo {
  setProgress(userId: string, mediaId: string, input: ProgressInput): WatchProgress
  getProgress(userId: string, mediaId: string): WatchProgress | null
  markWatched(userId: string, mediaId: string, watched: boolean): WatchProgress | null
  clear(userId: string, mediaId: string): boolean
  continueWatching(userId: string): ContinueWatchingItem[]
  /** Delete progress rows whose media is gone or soft-deleted (e.g. after a
   *  library root is removed and its items are swept). Returns rows deleted. */
  deleteOrphaned(): number
}

function computeWatched(positionMs: number, durationMs: number, thresholdPct: number): boolean {
  if (durationMs <= 0) return false
  if (positionMs / durationMs >= thresholdPct / 100) return true
  if (durationMs - positionMs <= WATCHED_TAIL_MS) return true
  return false
}

interface ProgressRow {
  user_id: string
  media_id: string
  position_ms: number
  duration_ms: number
  watched: number
  updated_at: number
}

function rowToProgress(row: ProgressRow): WatchProgress {
  return {
    mediaId: row.media_id,
    positionMs: row.position_ms,
    durationMs: row.duration_ms,
    watched: row.watched !== 0,
    updatedAt: row.updated_at,
  }
}

export function createProgressRepo(
  db: DatabaseSync,
  mediaRepo: MediaRepo,
  opts: ProgressRepoOpts,
): ProgressRepo {
  const upsertStmt = db.prepare(`
    INSERT INTO watch_progress (user_id, media_id, position_ms, duration_ms, watched, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, media_id) DO UPDATE SET
      position_ms = excluded.position_ms,
      duration_ms = excluded.duration_ms,
      watched     = CASE WHEN watch_progress.watched = 1 THEN 1 ELSE excluded.watched END,
      updated_at  = excluded.updated_at
  `)

  return {
    setProgress(userId, mediaId, input) {
      const threshold = opts.getWatchedThresholdPct()
      const watched = computeWatched(input.positionMs, input.durationMs, threshold) ? 1 : 0
      const now = Date.now()
      upsertStmt.run(userId, mediaId, input.positionMs, input.durationMs, watched, now)
      return rowToProgress(
        db.prepare('SELECT * FROM watch_progress WHERE user_id = ? AND media_id = ?')
          .get(userId, mediaId) as ProgressRow,
      )
    },

    getProgress(userId, mediaId) {
      const row = db.prepare('SELECT * FROM watch_progress WHERE user_id = ? AND media_id = ?')
        .get(userId, mediaId) as ProgressRow | undefined
      return row ? rowToProgress(row) : null
    },

    markWatched(userId, mediaId, watched) {
      const existing = this.getProgress(userId, mediaId)
      if (!existing) return null
      db.prepare(
        `UPDATE watch_progress
            SET watched = ?, updated_at = ?
          WHERE user_id = ? AND media_id = ?`,
      ).run(watched ? 1 : 0, Date.now(), userId, mediaId)
      return this.getProgress(userId, mediaId)
    },

    clear(userId, mediaId) {
      const res = db.prepare(
        'DELETE FROM watch_progress WHERE user_id = ? AND media_id = ?',
      ).run(userId, mediaId)
      return (res as any).changes > 0
    },

    deleteOrphaned() {
      const res = db.prepare(
        `DELETE FROM watch_progress
          WHERE media_id NOT IN (SELECT id FROM media_items WHERE deleted_at IS NULL)`,
      ).run()
      return (res as any).changes as number
    },

    continueWatching(userId) {
      // Step 1: all rows for user, newest first, join media to resolve kinds.
      const rows = db.prepare(
        `SELECT wp.user_id, wp.media_id, wp.position_ms, wp.duration_ms, wp.watched, wp.updated_at,
                mi.kind, mi.parent_id
           FROM watch_progress wp
           JOIN media_items mi ON mi.id = wp.media_id AND mi.deleted_at IS NULL
          WHERE wp.user_id = ?
          ORDER BY wp.updated_at DESC`,
      ).all(userId) as Array<ProgressRow & { kind: 'movie' | 'episode'; parent_id: string | null }>

      const out: ContinueWatchingItem[] = []
      const seenShows = new Set<string>()
      const showLatestUpdated = new Map<string, number>()      // showId → latest row updated_at
      const showLatestRow = new Map<string, typeof rows[number]>()

      // Pass 1: unwatched entries, one per show for episodes.
      for (const row of rows) {
        if (row.kind === 'movie') {
          if (row.watched) continue
          const media = mediaRepo.getById(row.media_id)
          if (!media) continue
          out.push(toItem(row, media))
        } else {
          // episode: track show-latest regardless of watched, for pass 2
          const showId = row.parent_id!
          if (!showLatestUpdated.has(showId)) {
            showLatestUpdated.set(showId, row.updated_at)
            showLatestRow.set(showId, row)
          }
          if (row.watched) continue
          if (seenShows.has(showId)) continue
          seenShows.add(showId)
          const media = mediaRepo.getById(row.media_id)
          if (!media) continue
          const show = mediaRepo.getById(showId)
          if (!show) continue
          out.push(toItem(row, media, show))
        }
      }

      // Pass 2: next-up promotion. If the show's latest-touched episode was
      // watched and no unwatched entry for the show landed above, find the
      // next episode in (season, episode) order that isn't watched.
      for (const [showId, latest] of showLatestRow) {
        if (seenShows.has(showId)) continue
        if (!latest.watched) continue     // Pass 1 would have handled it
        const latestMedia = mediaRepo.getById(latest.media_id)
        if (!latestMedia || latestMedia.season == null || latestMedia.episode == null) continue
        const next = db.prepare(
          `SELECT * FROM media_items
            WHERE kind = 'episode' AND parent_id = ? AND deleted_at IS NULL
              AND (season > ? OR (season = ? AND episode > ?))
              AND id NOT IN (
                SELECT media_id FROM watch_progress
                 WHERE user_id = ? AND media_id IN (
                   SELECT id FROM media_items WHERE parent_id = ?
                 ) AND watched = 1
              )
            ORDER BY season ASC, episode ASC
            LIMIT 1`,
        ).get(latestMedia.parentId, latestMedia.season, latestMedia.season, latestMedia.episode, userId, showId) as any
        if (!next) continue
        const nextMedia = mediaRepo.getById(next.id)
        const show = mediaRepo.getById(showId)
        if (!nextMedia || !show) continue
        out.push({
          mediaId: nextMedia.id,
          kind: 'episode',
          positionMs: 0,
          durationMs: Math.round((nextMedia.durationSec ?? 0) * 1000),
          percent: 0,
          updatedAt: latest.updated_at,
          media: nextMedia,
          show,
        })
      }

      // Sort by updatedAt desc, cap at 20.
      out.sort((a, b) => b.updatedAt - a.updatedAt)
      return out.slice(0, 20)
    },
  }
}

function toItem(
  row: { media_id: string; position_ms: number; duration_ms: number; updated_at: number; kind: 'movie' | 'episode' },
  media: MediaItem,
  show?: MediaItem,
): ContinueWatchingItem {
  return {
    mediaId: row.media_id,
    kind: row.kind,
    positionMs: row.position_ms,
    durationMs: row.duration_ms,
    percent: row.duration_ms > 0 ? Math.round((row.position_ms / row.duration_ms) * 100) : 0,
    updatedAt: row.updated_at,
    media,
    show,
  }
}
