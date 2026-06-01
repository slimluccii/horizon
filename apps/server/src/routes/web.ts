import type { FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import { sendNotFound, ErrorCodes } from './errors.ts'

/**
 * API route prefixes owned by the JSON API. An unmatched request under one of
 * these is a real 404 (a bad API call), NOT a client-side route — so it must
 * return JSON, never the SPA shell. Everything else falls through to index.html
 * so the browser-side router (react-router) can handle deep links / reloads.
 *
 * Note `/settings/server` (the API) rather than `/settings` (a web page): the
 * web UI has a `/settings` route, so only the deeper API path is reserved.
 */
const API_PREFIXES = [
  '/library',
  '/sessions',
  '/users',
  '/metadata',
  '/health',
  '/dev',
  '/settings/server',
]

function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'))
}

/**
 * Serve the bundled web UI (apps/web/dist) same-origin, Plex/Jellyfin style.
 * Registered AFTER all API routes so real endpoints always win. Static assets
 * are served directly; any other GET resolves to the SPA shell via the
 * not-found handler (wildcard:false lets misses fall through to it).
 *
 * Must be called last in buildServer, and only when cfg.serveWeb is true.
 */
export async function registerWeb(app: FastifyInstance, webDir: string): Promise<void> {
  await app.register(fastifyStatic, { root: webDir, wildcard: false })

  app.setNotFoundHandler((req, reply) => {
    const pathname = req.url.split('?')[0]
    // Non-GET or genuine API misses get a JSON 404 — never the HTML shell.
    if (req.method !== 'GET' || isApiPath(pathname)) {
      return sendNotFound(reply, ErrorCodes.NOT_FOUND, 'Not found')
    }
    // Client-side route or deep link → hand off to the SPA.
    return reply.sendFile('index.html')
  })

  app.log.info(`Serving web UI from ${webDir}`)
}
