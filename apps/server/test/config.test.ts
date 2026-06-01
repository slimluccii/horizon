import { describe, it, expect, beforeEach } from 'vitest'

describe('config', () => {
  beforeEach(() => {
    delete process.env.HORIZON_PORT
    delete process.env.HORIZON_MEDIA_BASE
    delete process.env.HORIZON_CORS_ORIGINS
    delete process.env.HORIZON_CACHE_DIR
    delete process.env.HORIZON_MAX_SESSIONS
    delete process.env.HORIZON_WS_GRACE_MS
    delete process.env.HORIZON_WS_ATTACH_MS
    delete process.env.HORIZON_MAX_RENDITIONS
  })

  it('returns defaults when env vars not set', async () => {
    const { loadConfig } = await import('../src/config.ts')
    const cfg = loadConfig()
    expect(cfg.port).toBe(7777)
    expect(cfg.maxSessions).toBe(4)
    expect(cfg.wsGraceMs).toBe(10000)
    expect(cfg.wsAttachMs).toBe(10000)
    expect(cfg.maxRenditions).toBe(3)
    expect(cfg.mediaBases).toEqual(['/media'])
  })

  it('parses env vars', async () => {
    process.env.HORIZON_PORT = '8888'
    process.env.HORIZON_MEDIA_BASE = '/media1:/media2'
    process.env.HORIZON_MAX_SESSIONS = '2'
    const { loadConfig } = await import('../src/config.ts')
    const cfg = loadConfig()
    expect(cfg.port).toBe(8888)
    expect(cfg.mediaBases).toEqual(['/media1', '/media2'])
    expect(cfg.maxSessions).toBe(2)
  })
})

describe('loadConfig — database', () => {
  it('defaults dbPath to <cacheDir>/horizon.db and threshold to 90', () => {
    delete process.env.HORIZON_DB_PATH
    delete process.env.HORIZON_WATCHED_THRESHOLD_PCT
    const { loadConfig } = require('../src/config.ts')
    const cfg = loadConfig()
    expect(cfg.dbPath.endsWith('/horizon.db')).toBe(true)
    expect(cfg.watchedThresholdPct).toBe(90)
  })

  it('respects overrides', () => {
    process.env.HORIZON_DB_PATH = '/tmp/custom.db'
    process.env.HORIZON_WATCHED_THRESHOLD_PCT = '75'
    const { loadConfig } = require('../src/config.ts')
    const cfg = loadConfig()
    expect(cfg.dbPath).toBe('/tmp/custom.db')
    expect(cfg.watchedThresholdPct).toBe(75)
    delete process.env.HORIZON_DB_PATH
    delete process.env.HORIZON_WATCHED_THRESHOLD_PCT
  })
})
