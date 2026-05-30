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
  refreshWorker: MetadataRefreshWorker | null
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
    origin: cfg.corsOrigins.includes('*') ? true : cfg.corsOrigins,
  })
  await app.register(fastifyWebSocket)

  registerHealth(app, hwAccel)
  registerLibrary(app, repos.mediaRepo, repos.collectionsRepo, workers)
  registerSessions(app, cfg, hwAccel, sessions, repos.progressRepo, orchestrator, repos.serverSettings)
  registerPlaylists(app, sessions)
  registerSegments(app, hwAccel, sessions)
  registerMetadata(app, cfg)
  registerUsers(app, repos.userRepo)
  registerProgress(app, repos.userRepo, repos.progressRepo)
  registerSettings(app, repos.userRepo, repos.serverSettings)

  if (cfg.devSeedEnabled && db) {
    app.log.warn('HORIZON_DEV_SEED=1 — exposing POST /dev/seed/:scenario. DO NOT enable in production.')
    registerDev(app, { media: repos.mediaRepo, collections: repos.collectionsRepo, db })
  }

  return app
}
