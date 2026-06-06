import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { UserRepo } from '../../../identity/index.ts'
import type { ProgressRepo } from '../persistence/progress.ts'
import { sendNotFound, badRequest, errorReply, ErrorCodes } from '../../../../platform/http/errors.ts'

const PatchBody = z.object({ watched: z.boolean() })

/**
 * The acting user for a per-user route is the ACTIVE PROFILE (req.profileUserId,
 * set by the resolveProfile hook) — never the path param or the session
 * principal. The `:userId` path segment is kept for REST shape, but it must
 * agree with the active profile: a client no longer asserts identity by typing
 * an id into the URL. Returns the acting user id, or null after replying.
 */
function actingUser(req: FastifyRequest, reply: FastifyReply): string | null {
  const actingUserId = req.profileUserId
  if (!actingUserId) {
    errorReply(reply, 401, ErrorCodes.UNAUTHORIZED, 'Authentication required')
    return null
  }
  const pathUserId = (req.params as { userId: string }).userId
  if (pathUserId !== actingUserId) {
    errorReply(reply, 403, ErrorCodes.USER_MISMATCH, 'Profile mismatch')
    return null
  }
  return actingUserId
}

export function registerProgress(
  app: FastifyInstance,
  users: UserRepo,
  progress: ProgressRepo,
): void {
  app.get<{ Params: { userId: string } }>(
    '/users/:userId/continue-watching',
    async (req, reply) => {
      const userId = actingUser(req, reply)
      if (!userId) return
      return progress.continueWatching(userId)
    },
  )

  app.get<{ Params: { userId: string; mediaId: string } }>(
    '/users/:userId/progress/:mediaId',
    async (req, reply) => {
      const userId = actingUser(req, reply)
      if (!userId) return
      const wp = progress.getProgress(userId, req.params.mediaId)
      if (!wp) return sendNotFound(reply, ErrorCodes.PROGRESS_NOT_FOUND, 'No progress for media')
      return wp
    },
  )

  app.patch<{ Params: { userId: string; mediaId: string } }>(
    '/users/:userId/progress/:mediaId',
    async (req, reply) => {
      const userId = actingUser(req, reply)
      if (!userId) return
      const parse = PatchBody.safeParse(req.body)
      if (!parse.success) return badRequest(reply, ErrorCodes.INVALID_INPUT, parse.error.message)
      const wp = progress.markWatched(userId, req.params.mediaId, parse.data.watched)
      if (!wp) return sendNotFound(reply, ErrorCodes.PROGRESS_NOT_FOUND, 'No progress for media')
      return wp
    },
  )

  app.delete<{ Params: { userId: string; mediaId: string } }>(
    '/users/:userId/progress/:mediaId',
    async (req, reply) => {
      const userId = actingUser(req, reply)
      if (!userId) return
      progress.clear(userId, req.params.mediaId)
      return reply.status(204).send()
    },
  )
}
