import { EventEmitter } from 'node:events'
import type { DatabaseSync } from './db/index.ts'

export interface ServerSettingsValues {
  scanConcurrency: number
  scanCronHour: number
  watchFs: boolean
  watchDebounceMs: number
  metadataBatchSize: number
  metadataMaxAgeMovieDays: number
  metadataMaxAgeShowDays: number
  metadataMaxAgeEpisodeDays: number
  watchedThresholdPct: number
  maxSessions: number
  wsGraceMs: number
  wsAttachMs: number
  maxRenditions: number
}

export interface ServerSettingsChange {
  prev: ServerSettingsValues
  next: ServerSettingsValues
  diff: Partial<ServerSettingsValues>
}

export interface ServerSettings {
  get(): ServerSettingsValues
  update(patch: Partial<ServerSettingsValues>): ServerSettingsValues
  on(event: 'change', listener: (c: ServerSettingsChange) => void): () => void
}

interface RegistryEntry {
  column: string
  key: keyof ServerSettingsValues
  envVar: string
  kind: 'int' | 'bool'
  default: number
}

const SETTINGS_REGISTRY: RegistryEntry[] = [
  { column: 'scan_concurrency',              key: 'scanConcurrency',           envVar: 'HORIZON_SCAN_CONCURRENCY',              kind: 'int',  default: 4 },
  { column: 'scan_cron_hour',                key: 'scanCronHour',              envVar: 'HORIZON_SCAN_CRON_HOUR',                kind: 'int',  default: 3 },
  { column: 'watch_fs',                      key: 'watchFs',                   envVar: 'HORIZON_WATCH_FS',                      kind: 'bool', default: 0 },
  { column: 'watch_debounce_ms',             key: 'watchDebounceMs',           envVar: 'HORIZON_WATCH_DEBOUNCE_MS',             kind: 'int',  default: 5000 },
  { column: 'metadata_batch_size',           key: 'metadataBatchSize',         envVar: 'HORIZON_METADATA_BATCH_SIZE',           kind: 'int',  default: 50 },
  { column: 'metadata_max_age_movie_days',   key: 'metadataMaxAgeMovieDays',   envVar: 'HORIZON_METADATA_MAX_AGE_MOVIE_DAYS',   kind: 'int',  default: 30 },
  { column: 'metadata_max_age_show_days',    key: 'metadataMaxAgeShowDays',    envVar: 'HORIZON_METADATA_MAX_AGE_SHOW_DAYS',    kind: 'int',  default: 7 },
  { column: 'metadata_max_age_episode_days', key: 'metadataMaxAgeEpisodeDays', envVar: 'HORIZON_METADATA_MAX_AGE_EPISODE_DAYS', kind: 'int',  default: 60 },
  { column: 'watched_threshold_pct',         key: 'watchedThresholdPct',       envVar: 'HORIZON_WATCHED_THRESHOLD_PCT',         kind: 'int',  default: 90 },
  { column: 'max_sessions',                  key: 'maxSessions',               envVar: 'HORIZON_MAX_SESSIONS',                  kind: 'int',  default: 4 },
  { column: 'ws_grace_ms',                   key: 'wsGraceMs',                 envVar: 'HORIZON_WS_GRACE_MS',                   kind: 'int',  default: 10000 },
  { column: 'ws_attach_ms',                  key: 'wsAttachMs',                envVar: 'HORIZON_WS_ATTACH_MS',                  kind: 'int',  default: 10000 },
  { column: 'max_renditions',                key: 'maxRenditions',             envVar: 'HORIZON_MAX_RENDITIONS',                kind: 'int',  default: 3 },
]

const VALID_KEYS = new Set<string>(SETTINGS_REGISTRY.map(e => e.key))

function parseRow(row: Record<string, number>): ServerSettingsValues {
  const result = {} as Record<string, unknown>
  for (const entry of SETTINGS_REGISTRY) {
    const raw = row[entry.column] as number
    result[entry.key] = entry.kind === 'bool' ? raw !== 0 : raw
  }
  return result as unknown as ServerSettingsValues
}

function computeDiff(prev: ServerSettingsValues, next: ServerSettingsValues): Partial<ServerSettingsValues> {
  const diff: Partial<ServerSettingsValues> = {}
  for (const entry of SETTINGS_REGISTRY) {
    const k = entry.key
    if (prev[k] !== next[k]) {
      (diff as Record<string, unknown>)[k] = next[k]
    }
  }
  return diff
}

export function createServerSettings(db: DatabaseSync): ServerSettings {
  const emitter = new EventEmitter()
  const selectStmt = db.prepare('SELECT * FROM server_settings WHERE id = 1')
  let cached: ServerSettingsValues | null = null

  function readRow(): ServerSettingsValues {
    return parseRow(selectStmt.get() as Record<string, number>)
  }

  return {
    get() {
      if (!cached) cached = readRow()
      return cached
    },

    update(patch) {
      const keys = Object.keys(patch) as Array<keyof ServerSettingsValues>
      for (const k of keys) {
        if (!VALID_KEYS.has(k as string)) {
          throw new Error(`Unknown settings key: ${String(k)}`)
        }
      }

      const prev = this.get()

      const setClauses: string[] = []
      const params: unknown[] = []
      for (const k of keys) {
        const entry = SETTINGS_REGISTRY.find(e => e.key === k)!
        setClauses.push(`${entry.column} = ?`)
        const v = patch[k]
        params.push(entry.kind === 'bool' ? ((v as boolean) ? 1 : 0) : (v as number))
      }
      setClauses.push('updated_at = ?')
      params.push(Date.now())

      db.prepare(`UPDATE server_settings SET ${setClauses.join(', ')} WHERE id = 1`).run(...params)

      cached = readRow()
      const next = cached
      const diff = computeDiff(prev, next)

      emitter.emit('change', { prev, next, diff } satisfies ServerSettingsChange)

      return next
    },

    on(_event, listener) {
      emitter.on('change', listener)
      return () => emitter.off('change', listener)
    },
  }
}

export function bootstrapFromEnv(
  db: DatabaseSync,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  now = Date.now,
): void {
  const row = db.prepare('SELECT seeded_from_env FROM server_settings WHERE id = 1').get() as { seeded_from_env: number }
  if (row.seeded_from_env === 1) return

  const setClauses: string[] = ['seeded_from_env = 1', 'updated_at = ?']
  const params: unknown[] = [now()]

  for (const entry of SETTINGS_REGISTRY) {
    const raw = env[entry.envVar]
    if (raw == null || raw === '') continue

    if (entry.kind === 'int') {
      const n = parseInt(raw, 10)
      if (!Number.isFinite(n) || n < 0) continue
      setClauses.push(`${entry.column} = ?`)
      params.push(n)
    } else {
      const v = raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes' ? 1 : 0
      setClauses.push(`${entry.column} = ?`)
      params.push(v)
    }
  }

  db.prepare(`UPDATE server_settings SET ${setClauses.join(', ')} WHERE id = 1`).run(...params)
}
