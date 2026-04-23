import type { DatabaseSync } from '../db/index.ts'

export interface HdrFlags { dv: boolean; hdr10: boolean; hdr10plus: boolean; dvProfile?: number }
export interface ExternalIds { tmdb?: number; tvdb?: number; imdb?: string }

export interface AudioTrack {
  index: number
  codec: string
  channels: number
  language: string
  title: string
  default: boolean
}
export interface SubtitleTrack {
  index: number
  codec: string
  language: string
  forced: boolean
  embeddable: boolean
}

export interface MovieUpsert {
  id: string
  filePath: string
  title: string
  sortYear: number | null
  durationSec: number
  resolution: string
  videoCodec: string
  container: string
  hdr: HdrFlags
  audioTracks: AudioTrack[]
  subtitleTracks: SubtitleTrack[]
  mtimeMs: number
  sizeBytes: number
  externalIds: ExternalIds
  metadata: unknown
}

export interface ShowUpsert {
  id: string
  title: string
  sortYear: number | null
  externalIds: ExternalIds
  metadata: unknown
}

export interface EpisodeUpsert extends Omit<MovieUpsert, 'sortYear'> {
  parentId: string
  season: number
  episode: number
}

export interface MediaItem {
  id: string
  kind: 'movie' | 'show' | 'episode'
  parentId: string | null
  title: string
  sortYear: number | null
  season: number | null
  episode: number | null
  filePath: string | null
  durationSec: number | null
  resolution: string | null
  videoCodec: string | null
  container: string | null
  hdr: HdrFlags | null
  audioTracks: AudioTrack[] | null
  subtitleTracks: SubtitleTrack[] | null
  mtimeMs: number | null
  sizeBytes: number | null
  externalIds: ExternalIds
  metadata: unknown
  firstSeenAt: number
  lastSeenAt: number
  deletedAt: number | null
}

export interface MediaRepo {
  upsertMovie(input: MovieUpsert): MediaItem
  upsertShow(input: ShowUpsert): MediaItem
  upsertEpisode(input: EpisodeUpsert): MediaItem
  softDeleteMissing(seenIds: Set<string>): number
  listMovies(): MediaItem[]
  listShows(): MediaItem[]
  getEpisodes(showId: string): MediaItem[]
  getById(id: string): MediaItem | null
  getSeasons(showId: string): { number: number; episodeCount: number }[]
}

function rowToMedia(row: any): MediaItem {
  const j = <T>(s: string | null, fallback: T): T => (s ? JSON.parse(s) as T : fallback)
  return {
    id: row.id,
    kind: row.kind,
    parentId: row.parent_id,
    title: row.title,
    sortYear: row.sort_year,
    season: row.season,
    episode: row.episode,
    filePath: row.file_path,
    durationSec: row.duration_sec,
    resolution: row.resolution,
    videoCodec: row.video_codec,
    container: row.container,
    hdr: row.hdr ? JSON.parse(row.hdr) : null,
    audioTracks: row.audio_tracks ? JSON.parse(row.audio_tracks) : null,
    subtitleTracks: row.subtitle_tracks ? JSON.parse(row.subtitle_tracks) : null,
    mtimeMs: row.mtime_ms,
    sizeBytes: row.size_bytes,
    externalIds: j<ExternalIds>(row.external_ids, {}),
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    deletedAt: row.deleted_at,
  }
}

export function createMediaRepo(db: DatabaseSync): MediaRepo {
  const upsertMovieStmt = db.prepare(`
    INSERT INTO media_items (
      id, kind, parent_id, title, sort_year, season, episode,
      file_path, duration_sec, resolution, video_codec, container,
      hdr, audio_tracks, subtitle_tracks, mtime_ms, size_bytes,
      external_ids, metadata, first_seen_at, last_seen_at, deleted_at
    ) VALUES (
      ?, 'movie', NULL, ?, ?, NULL, NULL,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, NULL
    )
    ON CONFLICT(id) DO UPDATE SET
      title           = excluded.title,
      sort_year       = excluded.sort_year,
      file_path       = excluded.file_path,
      duration_sec    = excluded.duration_sec,
      resolution      = excluded.resolution,
      video_codec     = excluded.video_codec,
      container       = excluded.container,
      hdr             = excluded.hdr,
      audio_tracks    = excluded.audio_tracks,
      subtitle_tracks = excluded.subtitle_tracks,
      mtime_ms        = excluded.mtime_ms,
      size_bytes      = excluded.size_bytes,
      external_ids    = excluded.external_ids,
      metadata        = excluded.metadata,
      last_seen_at    = excluded.last_seen_at,
      deleted_at      = NULL
  `)

  const upsertShowStmt = db.prepare(`
    INSERT INTO media_items (
      id, kind, parent_id, title, sort_year,
      external_ids, metadata, first_seen_at, last_seen_at, deleted_at
    ) VALUES (
      ?, 'show', NULL, ?, ?,
      ?, ?, ?, ?, NULL
    )
    ON CONFLICT(id) DO UPDATE SET
      title        = excluded.title,
      sort_year    = excluded.sort_year,
      external_ids = excluded.external_ids,
      metadata     = excluded.metadata,
      last_seen_at = excluded.last_seen_at,
      deleted_at   = NULL
  `)

  const upsertEpisodeStmt = db.prepare(`
    INSERT INTO media_items (
      id, kind, parent_id, title, season, episode,
      file_path, duration_sec, resolution, video_codec, container,
      hdr, audio_tracks, subtitle_tracks, mtime_ms, size_bytes,
      external_ids, metadata, first_seen_at, last_seen_at, deleted_at
    ) VALUES (
      ?, 'episode', ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, NULL
    )
    ON CONFLICT(id) DO UPDATE SET
      parent_id       = excluded.parent_id,
      title           = excluded.title,
      season          = excluded.season,
      episode         = excluded.episode,
      file_path       = excluded.file_path,
      duration_sec    = excluded.duration_sec,
      resolution      = excluded.resolution,
      video_codec     = excluded.video_codec,
      container       = excluded.container,
      hdr             = excluded.hdr,
      audio_tracks    = excluded.audio_tracks,
      subtitle_tracks = excluded.subtitle_tracks,
      mtime_ms        = excluded.mtime_ms,
      size_bytes      = excluded.size_bytes,
      external_ids    = excluded.external_ids,
      metadata        = excluded.metadata,
      last_seen_at    = excluded.last_seen_at,
      deleted_at      = NULL
  `)

  const getById = (id: string): MediaItem | null => {
    const row = db.prepare('SELECT * FROM media_items WHERE id = ?').get(id)
    return row ? rowToMedia(row) : null
  }

  return {
    upsertMovie(input) {
      const now = Date.now()
      upsertMovieStmt.run(
        input.id, input.title, input.sortYear,
        input.filePath, input.durationSec, input.resolution, input.videoCodec, input.container,
        JSON.stringify(input.hdr), JSON.stringify(input.audioTracks), JSON.stringify(input.subtitleTracks),
        input.mtimeMs, input.sizeBytes,
        JSON.stringify(input.externalIds), input.metadata ? JSON.stringify(input.metadata) : null,
        now, now,
      )
      return getById(input.id)!
    },

    upsertShow(input) {
      const now = Date.now()
      upsertShowStmt.run(
        input.id, input.title, input.sortYear,
        JSON.stringify(input.externalIds), input.metadata ? JSON.stringify(input.metadata) : null,
        now, now,
      )
      return getById(input.id)!
    },

    upsertEpisode(input) {
      const now = Date.now()
      upsertEpisodeStmt.run(
        input.id, input.parentId, input.title, input.season, input.episode,
        input.filePath, input.durationSec, input.resolution, input.videoCodec, input.container,
        JSON.stringify(input.hdr), JSON.stringify(input.audioTracks), JSON.stringify(input.subtitleTracks),
        input.mtimeMs, input.sizeBytes,
        JSON.stringify(input.externalIds), input.metadata ? JSON.stringify(input.metadata) : null,
        now, now,
      )
      return getById(input.id)!
    },

    /**
     * Soft-delete rows whose id is NOT in seenIds and are not already deleted.
     * Uses a temp table to avoid SQLite's parameter-count limits on huge libraries.
     */
    softDeleteMissing(seenIds) {
      const now = Date.now()
      db.exec('CREATE TEMP TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY)')
      try {
        db.exec('DELETE FROM seen')
        const ins = db.prepare('INSERT OR IGNORE INTO seen (id) VALUES (?)')
        for (const id of seenIds) ins.run(id)
        const res = db.prepare(
          `UPDATE media_items
             SET deleted_at = ?
           WHERE deleted_at IS NULL
             AND id NOT IN (SELECT id FROM seen)`,
        ).run(now)
        return res.changes
      } finally {
        db.exec('DROP TABLE IF EXISTS seen')
      }
    },

    listMovies() {
      const rows = db.prepare(
        `SELECT * FROM media_items
          WHERE kind = 'movie' AND deleted_at IS NULL
          ORDER BY title ASC`,
      ).all()
      return rows.map(rowToMedia)
    },

    listShows() {
      const rows = db.prepare(
        `SELECT * FROM media_items
          WHERE kind = 'show' AND deleted_at IS NULL
          ORDER BY title ASC`,
      ).all()
      return rows.map(rowToMedia)
    },

    getEpisodes(showId) {
      const rows = db.prepare(
        `SELECT * FROM media_items
          WHERE kind = 'episode' AND parent_id = ? AND deleted_at IS NULL
          ORDER BY season ASC, episode ASC`,
      ).all(showId)
      return rows.map(rowToMedia)
    },

    getById,

    getSeasons(showId) {
      const rows = db.prepare(
        `SELECT season AS number, COUNT(*) AS episodeCount
           FROM media_items
          WHERE kind = 'episode' AND parent_id = ? AND deleted_at IS NULL
          GROUP BY season
          ORDER BY season ASC`,
      ).all(showId) as { number: number; episodeCount: number }[]
      return rows
    },
  }
}
