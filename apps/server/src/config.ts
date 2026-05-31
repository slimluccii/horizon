import os from 'node:os'
import { isToneMapOperator, type ToneMapOperator, type ToneMapConfig } from './transcode/tonemap.ts'

export interface Config {
  port: number
  moviesRoots: string[]
  showsRoots: string[]
  corsOrigins: string[]
  cacheDir: string
  dbPath: string
  watchedThresholdPct: number
  maxSessions: number
  wsGraceMs: number
  wsAttachMs: number
  maxRenditions: number
  forceEncoder: string | undefined
  /** TMDB API Read Access Token (Bearer JWT). Optional — metadata enrichment
   *  is skipped silently when missing so the server still works without it. */
  tmdbToken: string | undefined
  /** HDR → SDR tone-map configuration. Defaults to hable (cinematic). */
  toneMap: ToneMapConfig
  /** Concurrent ffprobe + metadata enrichments during library scan. Higher =
   *  faster boot on large libraries but more contention. */
  scanConcurrency: number
  /** Local-time hour [0..23] for the nightly full library scan. */
  scanCronHour: number
  /** Enable filesystem watcher for near-real-time scan triggers. Off by default
   *  because it's only reliable for local/bind-mounted FSes — SMB/NFS into a
   *  container won't deliver inotify events. */
  watchFs: boolean
  /** Debounce window for filesystem watcher events. Bursts (rsync, copy) collapse. */
  watchDebounceMs: number
  /** Max items refreshed per metadata-refresh tick. */
  metadataBatchSize: number
  /** Movie metadata max age before refresh (ms). */
  metadataMaxAgeMovieMs: number
  /** Show metadata max age before refresh (ms). Lower for ongoing shows. */
  metadataMaxAgeShowMs: number
  /** Episode metadata max age before refresh (ms). */
  metadataMaxAgeEpisodeMs: number
  /** Enable POST /dev/seed/:scenario (mock fixture loader). Off by default —
   *  only set HORIZON_DEV_SEED=1 in dev + e2e environments. */
  devSeedEnabled: boolean
  /** Runtime environment from NODE_ENV. Defaults to 'development' so existing
   *  dev setups (which rarely set NODE_ENV) keep working. Production
   *  deployments MUST set NODE_ENV=production — the startup guard then refuses
   *  to boot with HORIZON_DEV_SEED=1, so the dev seed routes can never be
   *  exposed in production. */
  nodeEnv: string
}

/** Parse env var as positive integer, falling back to default on missing/NaN. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`Config: ${name}="${raw}" invalid, using ${fallback}`)
    return fallback
  }
  return n
}

function envList(name: string, sep: string, fallback: string[] = []): string[] {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  return raw.split(sep).filter(Boolean)
}

export function loadConfig(): Config {
  const cacheDir = process.env.HORIZON_CACHE_DIR ?? `${os.tmpdir()}/horizon-cache`
  return {
    port: envInt('HORIZON_PORT', 7777),
    moviesRoots: envList('HORIZON_MOVIES_ROOT', ':'),
    showsRoots: envList('HORIZON_SHOWS_ROOT', ':'),
    corsOrigins: envList('HORIZON_CORS_ORIGINS', ',', ['*']),
    cacheDir,
    dbPath: process.env.HORIZON_DB_PATH ?? `${cacheDir}/horizon.db`,
    watchedThresholdPct: envInt('HORIZON_WATCHED_THRESHOLD_PCT', 90),
    maxSessions: envInt('HORIZON_MAX_SESSIONS', 4),
    wsGraceMs: envInt('HORIZON_WS_GRACE_MS', 10_000),
    wsAttachMs: envInt('HORIZON_WS_ATTACH_MS', 10_000),
    maxRenditions: envInt('HORIZON_MAX_RENDITIONS', 3),
    forceEncoder: process.env.HORIZON_FORCE_ENCODER,
    tmdbToken: process.env.HORIZON_TMDB_TOKEN,
    toneMap: loadToneMap(),
    scanConcurrency: envInt('HORIZON_SCAN_CONCURRENCY', 4),
    scanCronHour: clampHour(envInt('HORIZON_SCAN_CRON_HOUR', 3)),
    watchFs: envBool('HORIZON_WATCH_FS', false),
    watchDebounceMs: envInt('HORIZON_WATCH_DEBOUNCE_MS', 5_000),
    metadataBatchSize: envInt('HORIZON_METADATA_BATCH_SIZE', 50),
    metadataMaxAgeMovieMs: envInt('HORIZON_METADATA_MAX_AGE_MOVIE_DAYS', 30) * 86_400_000,
    metadataMaxAgeShowMs: envInt('HORIZON_METADATA_MAX_AGE_SHOW_DAYS', 7) * 86_400_000,
    metadataMaxAgeEpisodeMs: envInt('HORIZON_METADATA_MAX_AGE_EPISODE_DAYS', 60) * 86_400_000,
    devSeedEnabled: envBool('HORIZON_DEV_SEED', false),
    nodeEnv: process.env.NODE_ENV || 'development',
  }
}

function clampHour(h: number): number {
  if (h < 0) return 0
  if (h > 23) return 23
  return h
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes'
}

function loadToneMap(): ToneMapConfig {
  const opRaw = (process.env.HORIZON_TONEMAP_OPERATOR ?? 'hable').toLowerCase()
  const operator: ToneMapOperator = isToneMapOperator(opRaw) ? opRaw : 'hable'
  if (opRaw && !isToneMapOperator(opRaw)) {
    console.warn(`Config: HORIZON_TONEMAP_OPERATOR="${opRaw}" invalid, using "hable"`)
  }
  return {
    operator,
    param: floatOrUndef('HORIZON_TONEMAP_PARAM'),
    desat: floatOrUndef('HORIZON_TONEMAP_DESAT'),
    peak: floatOrUndef('HORIZON_TONEMAP_PEAK'),
    postCorrection: process.env.HORIZON_TONEMAP_POSTFIX !== '0',
  }
}

function floatOrUndef(name: string): number | undefined {
  const v = process.env[name]
  if (v == null || v === '') return undefined
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : undefined
}
