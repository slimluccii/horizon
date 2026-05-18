import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { UserRepo } from '../repos/users.ts'
import { sendNotFound, badRequest, errorReply } from './errors.ts'
import { PreferencesSchema } from '@horizon/sdk/preferences'

const CreateBody = z.object({
  name: z.string().min(1).max(100),
  avatar: z.string().nullable().optional(),
  preferences: z.record(z.string(), z.unknown()).optional(),
})
const PatchBody = z.object({
  name: z.string().min(1).max(100).optional(),
  avatar: z.string().nullable().optional(),
  preferences: PreferencesSchema.optional(),
})

export function registerUsers(app: FastifyInstance, users: UserRepo): void {
  app.post('/users', async (req, reply) => {
    const parse = CreateBody.safeParse(req.body)
    if (!parse.success) return badRequest(reply, 'invalid-input', parse.error.message)
    try {
      return users.create(parse.data)
    } catch (err) {
      if ((err as { code?: string }).code === 'name-taken') {
        return errorReply(reply, 409, 'name-taken', 'Profile name already in use')
      }
      throw err
    }
  })

  app.get('/users', async () => users.list())

  app.get<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
    const u = users.get(req.params.id)
    if (!u) return sendNotFound(reply, 'user-not-found', 'User not found')
    return u
  })

  app.patch<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
    const parse = PatchBody.safeParse(req.body)
    if (!parse.success) return badRequest(reply, 'invalid-input', parse.error.message)
    try {
      const { preferences, ...rest } = parse.data
      let updateData: typeof parse.data = rest
      if (preferences !== undefined) {
        const existing = users.get(req.params.id)
        if (!existing) return sendNotFound(reply, 'user-not-found', 'User not found')
        updateData = { ...rest, preferences: { ...existing.preferences, ...preferences } }
      }
      const u = users.update(req.params.id, updateData)
      if (!u) return sendNotFound(reply, 'user-not-found', 'User not found')
      return u
    } catch (err) {
      if ((err as { code?: string }).code === 'name-taken') {
        return errorReply(reply, 409, 'name-taken', 'Profile name already in use')
      }
      throw err
    }
  })

  app.delete<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
    users.delete(req.params.id)
    return reply.status(204).send()
  })
}
