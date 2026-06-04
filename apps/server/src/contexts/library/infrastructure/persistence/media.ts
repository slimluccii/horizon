import type { DatabaseSync } from '../../../../platform/db/connection.ts'

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

/**
 * Shared base for MediaItem (wire-safe) and MediaItemRow (internal-only).
 * Carries only the PUBLIC fields — the contract both shapes agree on.
 *
 * Do NOT extend MediaItem from MediaItemRow (or vice versa); they are sibling
 * types with the same public contract but different scopes. Keeping the
 * inheritance broken means TypeScript's structural subtyping will reject a
 * `MediaItemRow` where a `MediaItem` is expected — so a route that
 * accidentally calls `getInternalRow` can never serialize server internals to
 * the wire by construction.
 *
 * See CONTEXT.md → MediaItem / MediaItemRow.
 */
export interface MediaItemBase {
  id: string
  kind: 'movie' | 'show' | 'episode'
  parentId: string | null
  title: string
  /** Release year (movies) or first-air year (shows + episodes). Renamed
   *  from `sortYear` to match SDK + client expectations. */
  year: number | null
  season: number | null
  episode: number | null
  durationSec: number | null
  resolution: string | null
  videoCodec: string | null
  container: string | null
  hdr: HdrFlags | null
  audioTracks: AudioTrack[] | null
  subtitleTracks: SubtitleTrack[] | null
  externalIds: ExternalIds
  metadata: unknown
}

/**
 * Domain MediaItem — wire-safe + business-logic shape returned by every
 * public `MediaRepo.get*` / `list*` method. NO filesystem paths, NO DB
 * bookkeeping (firstSeenAt/lastSeenAt/deletedAt/mtimeMs/sizeBytes), NO
 * metadata refresh state (tmdbId, metadataFetchedAt, metadataFailedAt, etc).
 *
 * Internal callers that need those fields (orchestrator for filePath,
 * refresh worker for fetch bookkeeping) use `getInternalRow(id) → MediaItemRow`.
 *
 * Wire-safe projection of MediaItemBase — adds no fields.
 * See CONTEXT.md → MediaItem / MediaItemRow.
 */
export interface MediaItem extends MediaItemBase {}

/**
 * Row shape — public base + filesystem + DB bookkeeping. Returned by
 * `MediaRepo.getInternalRow(id)` only. Used by:
 *   - PlaybackOrchestrator (needs filePath for ffmpeg spawn)
 *   - MetadataRefreshWorker (already uses tmdbId / metadataFetchedAt via
 *     findStaleMetadata; but getInternalRow is available for ad-hoc reads)
 *   - Scanner (writes mtimeMs / sizeBytes via upserts; doesn't read row)
 *
 * Extends MediaItemBase (NOT MediaItem) so the compiler rejects assigning a
 * MediaItemRow where a MediaItem is expected.
 */
export interface MediaItemRow extends MediaItemBase {
  filePath: string | null
  mtimeMs: number | null
  sizeBytes: number | null
  firstSeenAt: number
  lastSeenAt: number
  deletedAt: number | null
  tmdbId: number | null
  metadataFetchedAt: number | null
  metadataFailedAt: number | null
  metadataFailedCount: number
}

/** Items eligible for metadata refresh, in priority order. */
export interface StaleMetadataPick {
  id: string
  kind: 'movie' | 'show' | 'episode'
  tmdbId: number | null
  externalIds: ExternalIds
  title: string
  sortYear: number | null
  parentId: string | null
  season: number | null
  episode: number | null
  metadataFetchedAt: number | null
  metadataFailedCount: number
}

export interface MediaRepo {
  upsertMovie(input: MovieUpsert): MediaItem
  upsertShow(input: ShowUpsert): MediaItem
  upsertEpisode(input: EpisodeUpsert): MediaItem
  softDeleteMissing(seenIds: Set<string>): number
  /** Soft-delete rows whose file_path is under `pathPrefix` and not in seenIds. */
  softDeleteMissingUnder(pathPrefix: string, seenIds: Set<string>): number
  listMovies(): MediaItem[]
  listShows(): MediaItem[]
  getEpisodes(showId: string): MediaItem[]
  getById(id: string): MediaItem | null
  /**
   * INTERNAL ONLY: returns the full DB row including filePath, mtimeMs,
   * sizeBytes, tmdbId, and metadata-refresh bookkeeping. NEVER serialize this
   * to the wire. Only called by PlaybackOrchestrator (needs filePath for the
   * ffmpeg spawn) and MetadataRefreshWorker (needs tmdbId / metadataFetchedAt).
   * Routes MUST use `getById()` instead — it returns the wire-safe MediaItem.
   *
   * The `Row` suffix is a naming signal that this is the unsafe, full-row
   * accessor; paired with issue #63's type split (MediaItem vs MediaItemRow are
   * sibling types), a route that mistakenly calls this can't even assign the
   * result where a MediaItem is expected.
   */
  getInternalRow(id: string): MediaItemRow | null
  /** Internal-only enumeration (used by MetadataRefresh). Returns the full
   *  row including bookkeeping. Never expose this over the wire. */
  getByTmdbId(tmdbId: number): MediaItemRow[]
  getSeasons(showId: string): { number: number; episodeCount: number }[]
  /**
   * Find items needing a metadata refresh. Picks (in order):
   *   1. items with no metadata yet, oldest failure first
   *   2. items past their max-age for their type
   * Caller decides max-age per row via `staleBefore` map keyed by kind tag.
   * `failedBackoff` filters out rows with a failure newer than (now - backoff).
   */
  findStaleMetadata(opts: {
    nowMs: number
    limit: number
    /** Min age in ms before re-fetch — by media kind. */
    maxAgeMs: { movie: number; show: number; episode: number }
    /** Skip items that failed within last N ms (× failedCount, capped). */
    failureBackoffMs: number
    failureBackoffCap: number
  }): StaleMetadataPick[]
  markMetadataFetched(id: string, tmdbId: number | null, nowMs: number): void
  markMetadataFailed(id: string, nowMs: number): void
}

function rowToInternal(row: any): MediaItemRow {
  const j = <T>(s: string | null, fallback: T): T => (s ? JSON.parse(s) as T : fallback)
  return {
    id: row.id,
    kind: row.kind,
    parentId: row.parent_id,
    title: row.title,
    year: row.sort_year,
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
    tmdbId: row.tmdb_id ?? null,
    metadataFetchedAt: row.metadata_fetched_at ?? null,
    metadataFailedAt: row.metadata_failed_at ?? null,
    metadataFailedCount: row.metadata_failed_count ?? 0,
  }
}

/** Strip row-only fields (filePath + bookkeeping) for wire/business use.
 *  Pure projection — single source of truth for what's in domain vs row. */
function rowToDomain(row: MediaItemBase): MediaItem {
  return {
    id: row.id,
    kind: row.kind,
    parentId: row.parentId,
    title: row.title,
    year: row.year,
    season: row.season,
    episode: row.episode,
    durationSec: row.durationSec,
    resolution: row.resolution,
    videoCodec: row.videoCodec,
    container: row.container,
    hdr: row.hdr,
    audioTracks: row.audioTracks,
    subtitleTracks: row.subtitleTracks,
    externalIds: row.externalIds,
    metadata: row.metadata,
  }
}

function rowToMedia(row: any): MediaItem {
  return rowToDomain(rowToInternal(row))
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

  // Domain getById hides soft-deleted rows from wire/business callers.
  // getInternalRow returns them so the scanner / tests can inspect deletion state.
  const getById = (id: string): MediaItem | null => {
    const row = db.prepare('SELECT * FROM media_items WHERE id = ? AND deleted_at IS NULL').get(id)
    return row ? rowToMedia(row) : null
  }

  // getInternalRow is sealed to internal callers only via naming convention.
  // Routes must call getById() for the wire-safe projection.
  const getInternalRow = (id: string): MediaItemRow | null => {
    const row = db.prepare('SELECT * FROM media_items WHERE id = ?').get(id)
    return row ? rowToInternal(row) : null
  }

  return {
    getInternalRow,
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

    softDeleteMissingUnder(pathPrefix, seenIds) {
      const now = Date.now()
      // Match file_path begins-with prefix; trailing-slash sensitive so we
      // don't match `/movies/Foo (2010)` when scanning `/movies/Foo`.
      const like = pathPrefix.endsWith('/') ? `${pathPrefix}%` : `${pathPrefix}/%`
      // Wrap the whole populate-then-update sequence in a transaction so a
      // failure partway through the INSERT loop (or the UPDATE) leaves the DB
      // untouched — never soft-deleting items off an incomplete `seen` set.
      try {
        db.exec('BEGIN')
        db.exec('CREATE TEMP TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY)')
        db.exec('DELETE FROM seen')
        const ins = db.prepare('INSERT OR IGNORE INTO seen (id) VALUES (?)')
        for (const id of seenIds) ins.run(id)
        const res = db.prepare(
          `UPDATE media_items
             SET deleted_at = ?
           WHERE deleted_at IS NULL
             AND file_path LIKE ?
             AND id NOT IN (SELECT id FROM seen)`,
        ).run(now, like)
        db.exec('COMMIT')
        return res.changes
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      } finally {
        db.exec('DROP TABLE IF EXISTS seen')
      }
    },

    /**
     * Soft-delete rows whose id is NOT in seenIds and are not already deleted.
     * Uses a temp table to avoid SQLite's parameter-count limits on huge libraries.
     * Wrapped in an explicit transaction so a mid-loop failure rolls back
     * atomically rather than soft-deleting against a partial `seen` set.
     */
    softDeleteMissing(seenIds) {
      const now = Date.now()
      try {
        db.exec('BEGIN')
        db.exec('CREATE TEMP TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY)')
        db.exec('DELETE FROM seen')
        const ins = db.prepare('INSERT OR IGNORE INTO seen (id) VALUES (?)')
        for (const id of seenIds) ins.run(id)
        const res = db.prepare(
          `UPDATE media_items
             SET deleted_at = ?
           WHERE deleted_at IS NULL
             AND id NOT IN (SELECT id FROM seen)`,
        ).run(now)
        db.exec('COMMIT')
        return res.changes
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
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

    getByTmdbId(tmdbId) {
      const rows = db.prepare(
        `SELECT * FROM media_items WHERE tmdb_id = ? AND deleted_at IS NULL`,
      ).all(tmdbId)
      return rows.map(rowToInternal)
    },

    findStaleMetadata(opts) {
      // Two passes — never-fetched first (priority), then past-max-age.
      // Both honor exponential failure backoff so we don't hammer permanent 404s.
      const cap = opts.failureBackoffCap
      const backoff = opts.failureBackoffMs
      // SQLite doesn't have MIN(a,b); inline the cap calc as CASE.
      const failureGuard = `
        AND (
          metadata_failed_count = 0
          OR metadata_failed_at IS NULL
          OR metadata_failed_at + (CASE
              WHEN ? * (1 << MIN(metadata_failed_count, 8)) > ?
              THEN ?
              ELSE ? * (1 << MIN(metadata_failed_count, 8))
            END) < ?
        )
      `
      const cols = `id, kind, tmdb_id, external_ids, title, sort_year, parent_id, season, episode, metadata_fetched_at, metadata_failed_count`
      const neverFetched = db.prepare(
        `SELECT ${cols}
           FROM media_items
          WHERE deleted_at IS NULL
            AND metadata_fetched_at IS NULL
            ${failureGuard}
          ORDER BY metadata_failed_count ASC, first_seen_at ASC
          LIMIT ?`,
      ).all(backoff, cap, cap, backoff, opts.nowMs, opts.limit) as any[]
      let remaining = opts.limit - neverFetched.length
      const staleByAge = remaining <= 0 ? [] : db.prepare(
        `SELECT ${cols}
           FROM media_items
          WHERE deleted_at IS NULL
            AND metadata_fetched_at IS NOT NULL
            AND metadata_fetched_at < (? - CASE kind
                WHEN 'movie'   THEN ?
                WHEN 'show'    THEN ?
                WHEN 'episode' THEN ?
                ELSE 0
              END)
            ${failureGuard}
          ORDER BY metadata_fetched_at ASC
          LIMIT ?`,
      ).all(
        opts.nowMs,
        opts.maxAgeMs.movie, opts.maxAgeMs.show, opts.maxAgeMs.episode,
        backoff, cap, cap, backoff, opts.nowMs,
        remaining,
      ) as any[]
      const all = [...neverFetched, ...staleByAge]
      return all.map(r => ({
        id: r.id,
        kind: r.kind,
        tmdbId: r.tmdb_id,
        externalIds: r.external_ids ? JSON.parse(r.external_ids) as ExternalIds : {},
        title: r.title,
        sortYear: r.sort_year,
        parentId: r.parent_id,
        season: r.season,
        episode: r.episode,
        metadataFetchedAt: r.metadata_fetched_at,
        metadataFailedCount: r.metadata_failed_count ?? 0,
      }))
    },

    markMetadataFetched(id, tmdbId, nowMs) {
      db.prepare(
        `UPDATE media_items
            SET tmdb_id = COALESCE(?, tmdb_id),
                metadata_fetched_at = ?,
                metadata_failed_at = NULL,
                metadata_failed_count = 0
          WHERE id = ?`,
      ).run(tmdbId, nowMs, id)
    },

    markMetadataFailed(id, nowMs) {
      db.prepare(
        `UPDATE media_items
            SET metadata_failed_at = ?,
                metadata_failed_count = metadata_failed_count + 1
          WHERE id = ?`,
      ).run(nowMs, id)
    },

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
