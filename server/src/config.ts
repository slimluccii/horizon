import os from 'node:os'

export interface Config {
  port: number
  moviesRoots: string[]
  showsRoots: string[]
  corsOrigins: string[]
  cacheDir: string
  maxSessions: number
  wsGraceMs: number
  wsAttachMs: number
  maxRenditions: number
  forceEncoder: string | undefined
}

export function loadConfig(): Config {
  return {
    port: parseInt(process.env.HORIZON_PORT ?? '7777'),
    moviesRoots: (process.env.HORIZON_MOVIES_ROOT ?? '').split(':').filter(Boolean),
    showsRoots: (process.env.HORIZON_SHOWS_ROOT ?? '').split(':').filter(Boolean),
    corsOrigins: (process.env.HORIZON_CORS_ORIGINS ?? '*').split(',').filter(Boolean),
    cacheDir: process.env.HORIZON_CACHE_DIR ?? `${os.tmpdir()}/horizon-cache`,
    maxSessions: parseInt(process.env.HORIZON_MAX_SESSIONS ?? '4'),
    wsGraceMs: parseInt(process.env.HORIZON_WS_GRACE_MS ?? '10000'),
    wsAttachMs: parseInt(process.env.HORIZON_WS_ATTACH_MS ?? '10000'),
    maxRenditions: parseInt(process.env.HORIZON_MAX_RENDITIONS ?? '3'),
    forceEncoder: process.env.HORIZON_FORCE_ENCODER,
  }
}
