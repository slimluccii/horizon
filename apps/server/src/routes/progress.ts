import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { UserRepo } from '../repos/users.ts'
import type { ProgressRepo } from '../repos/progress.ts'
import { sendNotFound, badRequest, ErrorCodes } from './errors.ts'
import { requireUser } from './authz.ts'

const PatchBody = z.object({ watched: z.boolean() })

export function registerProgress(
  app: FastifyInstance,
  users: UserRepo,
  progress: ProgressRepo,
): void {
  app.get<{ Params: { userId: string } }>(
    '/users/:userId/continue-watching',
    async (req, reply) => {
      const userId = requireUser(users, req, reply, req.params.userId)
      if (!userId) return
      return progress.continueWatching(userId)
    },
  )

  app.get<{ Params: { userId: string; mediaId: string } }>(
    '/users/:userId/progress/:mediaId',
    async (req, reply) => {
      const userId = requireUser(users, req, reply, req.params.userId)
      if (!userId) return
      const wp = progress.getProgress(userId, req.params.mediaId)
      if (!wp) return sendNotFound(reply, ErrorCodes.PROGRESS_NOT_FOUND, 'No progress for media')
      return wp
    },
  )

  app.patch<{ Params: { userId: string; mediaId: string } }>(
    '/users/:userId/progress/:mediaId',
    async (req, reply) => {
      const userId = requireUser(users, req, reply, req.params.userId)
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
      const userId = requireUser(users, req, reply, req.params.userId)
      if (!userId) return
      progress.clear(userId, req.params.mediaId)
      return reply.status(204).send()
    },
  )
}
