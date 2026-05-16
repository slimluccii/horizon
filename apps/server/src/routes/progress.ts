import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { UserRepo } from '../repos/users.ts'
import type { ProgressRepo } from '../repos/progress.ts'
import { sendNotFound, badRequest } from './errors.ts'

const PatchBody = z.object({ watched: z.boolean() })

/** Ensure the active-user header is present + matches the path user + resolves
 *  to an existing row. Returns null and writes a reply on failure. */
function requireUser(
  users: UserRepo,
  req: FastifyRequest,
  reply: FastifyReply,
  pathUserId: string,
): string | null {
  const hdr = req.headers['x-horizon-user']
  const id = typeof hdr === 'string' ? hdr : null
  if (!id) { badRequest(reply, 'no-user', 'Missing X-Horizon-User header'); return null }
  if (id !== pathUserId) { badRequest(reply, 'user-mismatch', 'Header user does not match path'); return null }
  if (!users.get(id)) { badRequest(reply, 'no-user', 'User not found'); return null }
  return id
}

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
      if (!wp) return sendNotFound(reply, 'progress-not-found', 'No progress for media')
      return wp
    },
  )

  app.patch<{ Params: { userId: string; mediaId: string } }>(
    '/users/:userId/progress/:mediaId',
    async (req, reply) => {
      const userId = requireUser(users, req, reply, req.params.userId)
      if (!userId) return
      const parse = PatchBody.safeParse(req.body)
      if (!parse.success) return badRequest(reply, 'invalid-input', parse.error.message)
      const wp = progress.markWatched(userId, req.params.mediaId, parse.data.watched)
      if (!wp) return sendNotFound(reply, 'progress-not-found', 'No progress for media')
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
