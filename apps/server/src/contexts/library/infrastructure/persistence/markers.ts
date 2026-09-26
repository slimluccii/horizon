import type { DatabaseSync } from '../../../../platform/db/connection.ts'
import type { Marker, MarkerKind } from '@horizon/sdk'

export type MarkerSource = 'chapter' | 'fingerprint'

export interface MarkersRepo {
  /** The markers of the file as it is now, one per kind, a chapter marker beating a fingerprint one. */
  get(mediaId: string): Marker[]
  /** Replaces everything the source stored for the file before. */
  replace(mediaId: string, source: MarkerSource, found: { mtimeMs: number; sizeBytes: number; markers: Marker[] }): void
}

export function createMarkersRepo(db: DatabaseSync): MarkersRepo {
  const del = db.prepare('DELETE FROM media_markers WHERE media_id = ? AND source = ?')
  const ins = db.prepare(
    `INSERT INTO media_markers (media_id, kind, source, start_ms, end_ms, mtime_ms, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const select = db.prepare(
    `SELECT x.kind, x.source, x.start_ms, x.end_ms FROM media_markers x
       JOIN media_items m ON m.id = x.media_id
      WHERE x.media_id = ? AND x.mtime_ms = m.mtime_ms AND x.size_bytes = m.size_bytes
      ORDER BY x.start_ms ASC`,
  )
  const replace = db.transaction((mediaId: string, source: MarkerSource, found: { mtimeMs: number; sizeBytes: number; markers: Marker[] }) => {
    del.run(mediaId, source)
    for (const m of found.markers) ins.run(mediaId, m.kind, source, m.startMs, m.endMs, found.mtimeMs, found.sizeBytes, Date.now())
  })
  return {
    get(mediaId) {
      const rows = select.all(mediaId) as { kind: MarkerKind; source: MarkerSource; start_ms: number; end_ms: number }[]
      const byKind = new Map<MarkerKind, Marker>()
      for (const r of rows) {
        if (byKind.has(r.kind) && r.source !== 'chapter') continue
        byKind.set(r.kind, { kind: r.kind, startMs: r.start_ms, endMs: r.end_ms })
      }
      return [...byKind.values()].sort((a, b) => a.startMs - b.startMs)
    },
    replace(mediaId, source, found) {
      replace(mediaId, source, found)
    },
  }
}
