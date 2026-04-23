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
  }
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
