import Fastify from 'fastify'
import fastifyWebSocket from '@fastify/websocket'
import fastifyCors from '@fastify/cors'
import type { Config } from './config.ts'
import type { HwAccel } from './transcode/hwaccel.ts'
import type { MediaRepo } from './repos/media.ts'
import type { CollectionsRepo } from './repos/collections.ts'
import type { UserRepo } from './repos/users.ts'
import type { ProgressRepo } from './repos/progress.ts'
import type { ScanHistoryRepo } from './repos/scanState.ts'
import type { ServerSettings } from './repos/serverSettings.ts'
import type { SessionManager } from './session/manager.ts'
import type { ScanManager } from './scanner/manager.ts'
import type { MetadataRefreshWorker } from './metadata/refresh.ts'
import type { PlaybackOrchestrator } from './session/playback.ts'
import { registerHealth } from './routes/health.ts'
import { registerLibrary } from './routes/library.ts'
import { registerSessions } from './routes/sessions.ts'
import { registerPlaylists } from './routes/playlists.ts'
import { registerSegments } from './routes/segments.ts'
import { registerMetadata } from './routes/metadata.ts'
import { registerUsers } from './routes/users.ts'
import { registerProgress } from './routes/progress.ts'
import { registerSettings } from './routes/settings.ts'
import { registerDev } from './routes/dev.ts'
import { registerWeb } from './routes/web.ts'
import { existsSync } from 'node:fs'
import type { DatabaseSync } from './db/index.ts'

export interface Repos {
  mediaRepo: MediaRepo
  collectionsRepo: CollectionsRepo
  userRepo: UserRepo
  progressRepo: ProgressRepo
  serverSettings: ServerSettings
}

export interface ScanWorkers {
  scanManager: ScanManager
  refreshWorker: MetadataRefreshWorker
  scanHistory: ScanHistoryRepo
}

export async function buildServer(
  cfg: Config,
  hwAccel: HwAccel,
  repos: Repos,
  sessions: SessionManager,
  workers: ScanWorkers,
  orchestrator: PlaybackOrchestrator,
  db?: DatabaseSync,
) {
  const app = Fastify({ logger: true })

  await app.register(fastifyCors, {
    // '*' → reflect any origin; a non-empty list → allow exactly those;
    // empty (the default) → disable CORS entirely (same-origin only), which is
    // correct when the web UI is served from this server or via the dev proxy.
    origin: cfg.corsOrigins.includes('*') ? true : (cfg.corsOrigins.length ? cfg.corsOrigins : false),
  })
  await app.register(fastifyWebSocket)

  registerHealth(app, hwAccel)
  registerLibrary(app, repos.mediaRepo, repos.collectionsRepo, workers, repos.userRepo, cfg)
  registerSessions(app, cfg, hwAccel, sessions, repos.progressRepo, orchestrator, repos.serverSettings, repos.userRepo)
  registerPlaylists(app, sessions, repos.userRepo)
  registerSegments(app, hwAccel, sessions, repos.mediaRepo, repos.userRepo)
  registerMetadata(app, cfg)
  registerUsers(app, repos.userRepo)
  registerProgress(app, repos.userRepo, repos.progressRepo)
  registerSettings(app, repos.userRepo, repos.serverSettings, cfg)

  if (cfg.devSeedEnabled && db) {
    app.log.warn('HORIZON_DEV_SEED=1 — exposing POST /dev/seed/:scenario. DO NOT enable in production.')
    registerDev(app, { media: repos.mediaRepo, collections: repos.collectionsRepo, db })
  }

  // Web UI last: its catch-all SPA fallback must not shadow any API route.
  if (cfg.serveWeb && cfg.webDir) {
    if (existsSync(cfg.webDir)) {
      await registerWeb(app, cfg.webDir)
    } else {
      app.log.warn(`HORIZON_WEB_DIR=${cfg.webDir} does not exist — web UI not served`)
    }
  }

  return app
}
