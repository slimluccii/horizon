import Fastify from 'fastify'
import fastifyWebSocket from '@fastify/websocket'
import fastifyCors from '@fastify/cors'
import type { Config } from './config.ts'
import type { HwAccel } from './transcode/hwaccel.ts'
import type { LibraryIndex } from './scanner/scanner.ts'
import type { SessionManager } from './session/manager.ts'
import { registerHealth } from './routes/health.ts'
import { registerLibrary } from './routes/library.ts'
import { registerSessions } from './routes/sessions.ts'

export async function buildServer(
  cfg: Config,
  hwAccel: HwAccel,
  index: LibraryIndex,
  sessions: SessionManager,
) {
  const app = Fastify({ logger: true })

  await app.register(fastifyCors, {
    origin: cfg.corsOrigins.includes('*') ? true : cfg.corsOrigins,
  })
  await app.register(fastifyWebSocket)

  registerHealth(app, hwAccel)
  registerLibrary(app, index)
  registerSessions(app, cfg, hwAccel, index, sessions)

  return app
}
