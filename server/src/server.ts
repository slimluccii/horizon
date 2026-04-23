import Fastify from 'fastify'
import fastifyWebSocket from '@fastify/websocket'
import fastifyCors from '@fastify/cors'
import type { Config } from './config.ts'
import type { HwAccel } from './transcode/hwaccel.ts'
import type { MediaRepo } from './repos/media.ts'
import type { CollectionsRepo } from './repos/collections.ts'
import type { UserRepo } from './repos/users.ts'
import type { ProgressRepo } from './repos/progress.ts'
import type { SessionManager } from './session/manager.ts'
import { registerHealth } from './routes/health.ts'
import { registerLibrary } from './routes/library.ts'
import { registerSessions } from './routes/sessions.ts'
import { registerPlaylists } from './routes/playlists.ts'
import { registerSegments } from './routes/segments.ts'
import { registerMetadata } from './routes/metadata.ts'

export interface Repos {
  mediaRepo: MediaRepo
  collectionsRepo: CollectionsRepo
  userRepo: UserRepo
  progressRepo: ProgressRepo
}

export async function buildServer(
  cfg: Config,
  hwAccel: HwAccel,
  repos: Repos,
  sessions: SessionManager,
) {
  const app = Fastify({ logger: true })

  await app.register(fastifyCors, {
    origin: cfg.corsOrigins.includes('*') ? true : cfg.corsOrigins,
  })
  await app.register(fastifyWebSocket)

  registerHealth(app, hwAccel)
  registerLibrary(app, repos.mediaRepo, repos.collectionsRepo)
  registerSessions(app, cfg, hwAccel, repos.mediaRepo, sessions)
  registerPlaylists(app, sessions)
  registerSegments(app, hwAccel, sessions)
  registerMetadata(app, cfg)

  return app
}
