/**
 * ServerSettings — singleton row access + change-event bus.
 *
 * Exposes:
 *   get()            → typed live row
 *   update(patch)    → persists partial update, emits 'change' with the diff
 *   bootstrapFromEnv(cfg) → overlays env-driven Config values on first boot
 *
 * Change events let active knobs (Scheduler, Watcher) react without polling.
 */
import { EventEmitter } from 'node:events'
import type { DatabaseSync } from '../../../../platform/db/connection.ts'
import type { Config } from '../../../../platform/config/config.ts'

export interface ServerSettingsRow {
  // Library
  watchedThresholdPct: number
  scanCronHour: number
  scanConcurrency: number
  watchFs: boolean
  watchDebounceMs: number
  /** Library roots (absolute paths), runtime-settable. JSON arrays in the DB. */
  moviesRoots: string[]
  showsRoots: string[]
  // Metadata
  tmdbToken: string | null
  metadataBatchSize: number
  metadataMaxAgeMovieDays: number
  metadataMaxAgeShowDays: number
  metadataMaxAgeEpDays: number
  // Playback
  maxSessions: number
  maxRenditions: number
  wsGraceMs: number
  wsAttachMs: number
  forceEncoder: string | null
  tonemapOperator: string
  tonemapParam: number | null
  tonemapDesat: number | null
  // Internal
  seededFromEnv: boolean
  updatedAt: number
}

export type ServerSettingsPatch = Partial<Omit<ServerSettingsRow, 'seededFromEnv' | 'updatedAt'>>

export interface SettingsChangeEvent {
  patch: ServerSettingsPatch
}

type DbRow = {
  watched_threshold_pct: number
  scan_cron_hour: number
  scan_concurrency: number
  watch_fs: number
  watch_debounce_ms: number
  movies_roots: string
  shows_roots: string
  tmdb_token: string | null
  metadata_batch_size: number
  metadata_max_age_movie_days: number
  metadata_max_age_show_days: number
  metadata_max_age_ep_days: number
  max_sessions: number
  max_renditions: number
  ws_grace_ms: number
  ws_attach_ms: number
  force_encoder: string | null
  tonemap_operator: string
  tonemap_param: number | null
  tonemap_desat: number | null
  seeded_from_env: number
  updated_at: number
}

/** Parse a JSON string-array column, tolerating null/garbage by returning []. */
function parseRoots(value: unknown): string[] {
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed as string[] : []
  } catch {
    return []
  }
}

function rowToSettings(row: DbRow): ServerSettingsRow {
  return {
    watchedThresholdPct: row.watched_threshold_pct,
    scanCronHour: row.scan_cron_hour,
    scanConcurrency: row.scan_concurrency,
    watchFs: row.watch_fs !== 0,
    watchDebounceMs: row.watch_debounce_ms,
    moviesRoots: parseRoots(row.movies_roots),
    showsRoots: parseRoots(row.shows_roots),
    tmdbToken: row.tmdb_token,
    metadataBatchSize: row.metadata_batch_size,
    metadataMaxAgeMovieDays: row.metadata_max_age_movie_days,
    metadataMaxAgeShowDays: row.metadata_max_age_show_days,
    metadataMaxAgeEpDays: row.metadata_max_age_ep_days,
    maxSessions: row.max_sessions,
    maxRenditions: row.max_renditions,
    wsGraceMs: row.ws_grace_ms,
    wsAttachMs: row.ws_attach_ms,
    forceEncoder: row.force_encoder,
    tonemapOperator: row.tonemap_operator,
    tonemapParam: row.tonemap_param,
    tonemapDesat: row.tonemap_desat,
    seededFromEnv: row.seeded_from_env !== 0,
    updatedAt: row.updated_at,
  }
}

export interface ServerSettings {
  get(): ServerSettingsRow
  update(patch: ServerSettingsPatch): ServerSettingsRow
  /** Overlays env Config values onto the DB row exactly once (when seeded_from_env=0). */
  bootstrapFromEnv(cfg: Config): void
  on(event: 'change', listener: (ev: SettingsChangeEvent) => void): this
  off(event: 'change', listener: (ev: SettingsChangeEvent) => void): this
}

export function createServerSettings(db: DatabaseSync): ServerSettings {
  const emitter = new EventEmitter()

  const SELECT = 'SELECT * FROM server_settings WHERE id = 1'

  function getRow(): DbRow {
    return db.prepare(SELECT).get() as DbRow
  }

  const settings: ServerSettings = {
    get() {
      return rowToSettings(getRow())
    },

    update(patch) {
      const now = Date.now()
      const sets: string[] = ['updated_at = ?']
      const vals: unknown[] = [now]

      if (patch.watchedThresholdPct !== undefined) { sets.push('watched_threshold_pct = ?'); vals.push(patch.watchedThresholdPct) }
      if (patch.scanCronHour !== undefined) { sets.push('scan_cron_hour = ?'); vals.push(patch.scanCronHour) }
      if (patch.scanConcurrency !== undefined) { sets.push('scan_concurrency = ?'); vals.push(patch.scanConcurrency) }
      if (patch.watchFs !== undefined) { sets.push('watch_fs = ?'); vals.push(patch.watchFs ? 1 : 0) }
      if (patch.watchDebounceMs !== undefined) { sets.push('watch_debounce_ms = ?'); vals.push(patch.watchDebounceMs) }
      if (patch.moviesRoots !== undefined) { sets.push('movies_roots = ?'); vals.push(JSON.stringify(patch.moviesRoots)) }
      if (patch.showsRoots !== undefined) { sets.push('shows_roots = ?'); vals.push(JSON.stringify(patch.showsRoots)) }
      if (patch.tmdbToken !== undefined) { sets.push('tmdb_token = ?'); vals.push(patch.tmdbToken) }
      if (patch.metadataBatchSize !== undefined) { sets.push('metadata_batch_size = ?'); vals.push(patch.metadataBatchSize) }
      if (patch.metadataMaxAgeMovieDays !== undefined) { sets.push('metadata_max_age_movie_days = ?'); vals.push(patch.metadataMaxAgeMovieDays) }
      if (patch.metadataMaxAgeShowDays !== undefined) { sets.push('metadata_max_age_show_days = ?'); vals.push(patch.metadataMaxAgeShowDays) }
      if (patch.metadataMaxAgeEpDays !== undefined) { sets.push('metadata_max_age_ep_days = ?'); vals.push(patch.metadataMaxAgeEpDays) }
      if (patch.maxSessions !== undefined) { sets.push('max_sessions = ?'); vals.push(patch.maxSessions) }
      if (patch.maxRenditions !== undefined) { sets.push('max_renditions = ?'); vals.push(patch.maxRenditions) }
      if (patch.wsGraceMs !== undefined) { sets.push('ws_grace_ms = ?'); vals.push(patch.wsGraceMs) }
      if (patch.wsAttachMs !== undefined) { sets.push('ws_attach_ms = ?'); vals.push(patch.wsAttachMs) }
      if (patch.forceEncoder !== undefined) { sets.push('force_encoder = ?'); vals.push(patch.forceEncoder) }
      if (patch.tonemapOperator !== undefined) { sets.push('tonemap_operator = ?'); vals.push(patch.tonemapOperator) }
      if (patch.tonemapParam !== undefined) { sets.push('tonemap_param = ?'); vals.push(patch.tonemapParam) }
      if (patch.tonemapDesat !== undefined) { sets.push('tonemap_desat = ?'); vals.push(patch.tonemapDesat) }

      vals.push(1) // WHERE id = 1
      db.prepare(`UPDATE server_settings SET ${sets.join(', ')} WHERE id = ?`).run(...vals)

      emitter.emit('change', { patch } satisfies SettingsChangeEvent)
      return rowToSettings(getRow())
    },

    bootstrapFromEnv(cfg) {
      const row = getRow()
      if (row.seeded_from_env !== 0) return   // already applied on a previous boot

      db.prepare(`
        UPDATE server_settings SET
          watched_threshold_pct       = ?,
          scan_cron_hour              = ?,
          scan_concurrency            = ?,
          watch_fs                    = ?,
          watch_debounce_ms           = ?,
          tmdb_token                  = ?,
          metadata_batch_size         = ?,
          metadata_max_age_movie_days = ?,
          metadata_max_age_show_days  = ?,
          metadata_max_age_ep_days    = ?,
          max_sessions                = ?,
          max_renditions              = ?,
          ws_grace_ms                 = ?,
          ws_attach_ms                = ?,
          force_encoder               = ?,
          tonemap_operator            = ?,
          tonemap_param               = ?,
          tonemap_desat               = ?,
          seeded_from_env             = 1,
          updated_at                  = ?
        WHERE id = 1
      `).run(
        cfg.watchedThresholdPct,
        cfg.scanCronHour,
        cfg.scanConcurrency,
        cfg.watchFs ? 1 : 0,
        cfg.watchDebounceMs,
        cfg.tmdbToken ?? null,
        cfg.metadataBatchSize,
        Math.round(cfg.metadataMaxAgeMovieMs / 86_400_000),
        Math.round(cfg.metadataMaxAgeShowMs / 86_400_000),
        Math.round(cfg.metadataMaxAgeEpisodeMs / 86_400_000),
        cfg.maxSessions,
        cfg.maxRenditions,
        cfg.wsGraceMs,
        cfg.wsAttachMs,
        cfg.forceEncoder ?? null,
        cfg.toneMap.operator,
        cfg.toneMap.param ?? null,
        cfg.toneMap.desat ?? null,
        Date.now(),
      )
    },

    on(event, listener) {
      emitter.on(event, listener)
      return this
    },

    off(event, listener) {
      emitter.off(event, listener)
      return this
    },
  }

  return settings
}
