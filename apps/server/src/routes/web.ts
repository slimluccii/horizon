import type { FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import { sendNotFound, ErrorCodes } from './errors.ts'

/**
 * Serve the bundled web UI (apps/web/dist) same-origin, Plex/Jellyfin style.
 * Registered at the root, AFTER the /api plugin. Static assets are served
 * directly; any other GET resolves to the SPA shell via the not-found handler
 * (wildcard:false lets misses fall through to it) so react-router handles deep
 * links / reloads.
 *
 * Since every backend endpoint now lives under `/api`, the rule is simple: an
 * unmatched request under `/api` is a real API 404 (JSON); anything else GET is
 * a client-side route → index.html.
 *
 * Must be called last in buildServer, and only when cfg.serveWeb is true.
 */
export async function registerWeb(app: FastifyInstance, webDir: string): Promise<void> {
  await app.register(fastifyStatic, { root: webDir, wildcard: false })

  app.setNotFoundHandler((req, reply) => {
    const pathname = req.url.split('?')[0]
    // Non-GET, or a genuine API miss → JSON 404, never the HTML shell.
    if (req.method !== 'GET' || pathname === '/api' || pathname.startsWith('/api/')) {
      return sendNotFound(reply, ErrorCodes.NOT_FOUND, 'Not found')
    }
    // Client-side route or deep link → hand off to the SPA.
    return reply.sendFile('index.html')
  })

  app.log.info(`Serving web UI from ${webDir}`)
}
