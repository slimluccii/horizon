import type { DatabaseSync } from '../../../../platform/db/connection.ts'
import type { Keyframe } from '../probe/keyframes.ts'

export interface KeyframeIndexRepo {
  /** The keyframes of the file as it is now; null when it was never indexed or has changed since. */
  get(mediaId: string): Keyframe[] | null
  put(mediaId: string, index: { mtimeMs: number; sizeBytes: number; keyframes: Keyframe[] }): void
  /** Playable files with no index for their current version, oldest first. */
  listUnindexed(): string[]
}

export function createKeyframeIndexRepo(db: DatabaseSync): KeyframeIndexRepo {
  return {
    get(mediaId) {
      const row = db.prepare(
        `SELECT k.keyframes FROM keyframe_index k
           JOIN media_items m ON m.id = k.media_id
          WHERE k.media_id = ? AND k.mtime_ms = m.mtime_ms AND k.size_bytes = m.size_bytes`,
      ).get(mediaId) as { keyframes: string } | undefined
      if (!row) return null
      return (JSON.parse(row.keyframes) as [number, number][]).map(([ptsSec, dtsSec]) => ({ ptsSec, dtsSec }))
    },

    listUnindexed() {
      const rows = db.prepare(
        `SELECT m.id FROM media_items m
           LEFT JOIN keyframe_index k
             ON k.media_id = m.id AND k.mtime_ms = m.mtime_ms AND k.size_bytes = m.size_bytes
          WHERE m.deleted_at IS NULL AND m.file_path IS NOT NULL AND k.media_id IS NULL
          ORDER BY m.first_seen_at ASC, m.id ASC`,
      ).all() as { id: string }[]
      return rows.map(r => r.id)
    },

    put(mediaId, index) {
      db.prepare(
        `INSERT INTO keyframe_index (media_id, mtime_ms, size_bytes, keyframes, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(media_id) DO UPDATE SET
           mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes,
           keyframes = excluded.keyframes, created_at = excluded.created_at`,
      ).run(mediaId, index.mtimeMs, index.sizeBytes, JSON.stringify(index.keyframes.map(k => [k.ptsSec, k.dtsSec])), Date.now())
    },
  }
}
