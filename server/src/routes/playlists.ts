import type { FastifyInstance } from 'fastify'
import type { SessionManager } from '../session/manager.ts'
import { buildRenditionPlaylist, buildMasterPlaylist } from '../transcode/playlist.ts'
import { sendNotFound, badRequest } from './errors.ts'

const HLS_CONTENT_TYPE = 'application/vnd.apple.mpegurl'

export function registerPlaylists(app: FastifyInstance, sessions: SessionManager): void {
  app.get<{ Params: { id: string } }>('/sessions/:id/stream.m3u8', async (req, reply) => {
    const session = sessions.get(req.params.id)
    if (!session) return sendNotFound(reply, 'session-not-found', 'Session not found')

    if (session.method === 'direct-stream' || session.method === 'partial-transcode') {
      // Single-rendition served as static VOD; segment URIs resolve under
      // /sessions/:id/renditions/0/... thanks to the explicit path prefix.
      const playlist = buildRenditionPlaylist(session.durationSec, 'renditions/0/')
      return reply.header('Content-Type', HLS_CONTENT_TYPE).send(playlist)
    }
    const master = buildMasterPlaylist(session.id, session.profiles, session.renditionCodecs)
    return reply.header('Content-Type', HLS_CONTENT_TYPE).send(master)
  })

  app.get<{ Params: { id: string; r: string } }>(
    '/sessions/:id/renditions/:r.m3u8',
    async (req, reply) => {
      const session = sessions.get(req.params.id)
      if (!session) return sendNotFound(reply, 'session-not-found', 'Session not found')
      if (!/^\d+$/.test(req.params.r)) return badRequest(reply, 'invalid-input', 'Invalid rendition')
      // Static VOD playlist for the entire media duration. Listed segments may
      // not yet exist on disk — the segment route produces them on demand.
      const playlist = buildRenditionPlaylist(session.durationSec, `${req.params.r}/`)
      return reply.header('Content-Type', HLS_CONTENT_TYPE).send(playlist)
    },
  )
}
