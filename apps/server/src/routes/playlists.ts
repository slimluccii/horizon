import type { FastifyInstance } from 'fastify'
import type { SessionManager } from '../session/manager.ts'
import { buildRenditionPlaylist, buildMasterPlaylist } from '../transcode/playlist.ts'
import { sendNotFound, badRequest, ErrorCodes } from './errors.ts'

const HLS_CONTENT_TYPE = 'application/vnd.apple.mpegurl'

export function registerPlaylists(app: FastifyInstance, sessions: SessionManager): void {
  app.get<{ Params: { id: string } }>('/sessions/:id/stream.m3u8', async (req, reply) => {
    const session = sessions.get(req.params.id)
    if (!session) return sendNotFound(reply, ErrorCodes.SESSION_NOT_FOUND, 'Session not found')

    // When there's exactly one rendition, skip the master wrapper and serve
    // the variant playlist directly. AVFoundation silently refuses any
    // multivariant playlist pointing at our fMP4 variants with -12927 even
    // though the same variant plays fine when loaded directly — the master
    // step adds zero value for a single rendition. hls.js treats a
    // variant-as-master equivalently.
    if (session.plan.renditions.length <= 1) {
      const playlist = buildRenditionPlaylist(session.durationSec, 'renditions/0/')
      return reply.header('Content-Type', HLS_CONTENT_TYPE).send(playlist)
    }
    const master = buildMasterPlaylist(session.id, session.plan.renditions.map(r => r.profile), session.renditionCodecs)
    return reply.header('Content-Type', HLS_CONTENT_TYPE).send(master)
  })

  app.get<{ Params: { id: string; r: string } }>(
    '/sessions/:id/renditions/:r.m3u8',
    async (req, reply) => {
      const session = sessions.get(req.params.id)
      if (!session) return sendNotFound(reply, ErrorCodes.SESSION_NOT_FOUND, 'Session not found')
      if (!/^\d+$/.test(req.params.r)) return badRequest(reply, ErrorCodes.INVALID_INPUT, 'Invalid rendition')
      const r = parseInt(req.params.r, 10)
      if (r < 0 || r >= session.plan.renditions.length) {
        return badRequest(reply, ErrorCodes.INVALID_INPUT, `Rendition ${r} does not exist`)
      }
      // Static VOD playlist for the entire media duration. Listed segments may
      // not yet exist on disk — the segment route produces them on demand.
      const playlist = buildRenditionPlaylist(session.durationSec, `${req.params.r}/`)
      return reply.header('Content-Type', HLS_CONTENT_TYPE).send(playlist)
    },
  )
}
