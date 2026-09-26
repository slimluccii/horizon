import type { FastifyInstance } from 'fastify'
import { sendNotFound, badRequest, ErrorCodes } from '../../../../platform/http/errors.ts'
import { resolveCallerRole } from '../../../identity/index.ts'
import type { MediaRepo } from '../persistence/media.ts'
import type { MarkersRepo } from '../persistence/markers.ts'

export function registerMarkers(app: FastifyInstance, media: MediaRepo, markers: MarkersRepo) {
  app.get<{ Params: { id: string } }>('/library/media/:id/markers', async (req, reply) => {
    const caller = resolveCallerRole(req)
    if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Authentication required')
    if (!media.getById(req.params.id)) return sendNotFound(reply, ErrorCodes.MEDIA_NOT_FOUND, 'Media not found')
    return markers.get(req.params.id)
  })
}
