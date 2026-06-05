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
    const { loadConfig } = await import('./config.ts')
    const cfg = loadConfig()
    expect(cfg.port).toBe(7777)
    expect(cfg.maxSessions).toBe(4)
    expect(cfg.wsGraceMs).toBe(10000)
    expect(cfg.wsAttachMs).toBe(10000)
    expect(cfg.maxRenditions).toBe(3)
  })

  it('parses env vars', async () => {
    process.env.HORIZON_PORT = '8888'
    process.env.HORIZON_MAX_SESSIONS = '2'
    const { loadConfig } = await import('./config.ts')
    const cfg = loadConfig()
    expect(cfg.port).toBe(8888)
    expect(cfg.maxSessions).toBe(2)
  })
})

describe('loadConfig — database', () => {
  it('defaults dbPath to <cacheDir>/horizon.db and threshold to 90', () => {
    delete process.env.HORIZON_DB_PATH
    delete process.env.HORIZON_WATCHED_THRESHOLD_PCT
    const { loadConfig } = require('./config.ts')
    const cfg = loadConfig()
    expect(cfg.dbPath.endsWith('/horizon.db')).toBe(true)
    expect(cfg.watchedThresholdPct).toBe(90)
  })

  it('respects overrides', () => {
    process.env.HORIZON_DB_PATH = '/tmp/custom.db'
    process.env.HORIZON_WATCHED_THRESHOLD_PCT = '75'
    const { loadConfig } = require('./config.ts')
    const cfg = loadConfig()
    expect(cfg.dbPath).toBe('/tmp/custom.db')
    expect(cfg.watchedThresholdPct).toBe(75)
    delete process.env.HORIZON_DB_PATH
    delete process.env.HORIZON_WATCHED_THRESHOLD_PCT
  })
})

describe('loadConfig — discovery', () => {
  const { loadConfig } = require('./config.ts')

  it('reads HORIZON_SERVER_NAME (undefined when unset)', () => {
    delete process.env.HORIZON_SERVER_NAME
    expect(loadConfig().serverName).toBeUndefined()
    process.env.HORIZON_SERVER_NAME = 'Living Room'
    expect(loadConfig().serverName).toBe('Living Room')
    delete process.env.HORIZON_SERVER_NAME
  })

  it('defaults mdnsEnabled to true, HORIZON_MDNS=0 disables', () => {
    delete process.env.HORIZON_MDNS
    expect(loadConfig().mdnsEnabled).toBe(true)
    process.env.HORIZON_MDNS = '0'
    expect(loadConfig().mdnsEnabled).toBe(false)
    delete process.env.HORIZON_MDNS
  })
})
