import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { UserRepo } from '../repos/users.ts'
import { sendNotFound, badRequest, errorReply } from './errors.ts'
import { resolveCallerRole } from './authz.ts'
import { PreferencesSchema } from '@horizon/sdk/preferences'

const CreateBody = z.object({
  name: z.string().min(1).max(100),
  avatar: z.string().nullable().optional(),
  preferences: PreferencesSchema.optional(),
})
const PatchBody = z.object({
  name: z.string().min(1).max(100).optional(),
  avatar: z.string().nullable().optional(),
  preferences: PreferencesSchema.optional(),
  role: z.enum(['owner', 'admin', 'member']).optional(),
})

export function registerUsers(app: FastifyInstance, users: UserRepo): void {
  app.post('/users', async (req, reply) => {
    const parse = CreateBody.safeParse(req.body)
    if (!parse.success) return badRequest(reply, 'invalid-input', parse.error.message)
    try {
      const { preferences, ...rest } = parse.data
      return users.create({
        ...rest,
        ...(preferences !== undefined ? { preferences: preferences as Record<string, unknown> } : {}),
      })
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === 'name-taken') {
        return errorReply(reply, 409, 'name-taken', 'Profile name already in use')
      }
      if (code === 'owner-exists') {
        return errorReply(reply, 409, 'owner-exists', 'A household owner already exists')
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
    if (parse.data.role !== undefined) {
      const caller = resolveCallerRole(users, req)
      if (!caller) return badRequest(reply, 'no-user', 'Missing or unknown X-Horizon-User header')
      if (caller.role === 'member') return errorReply(reply, 403, 'caller-forbidden', 'Only owner or admin can change roles')
    }
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
      const code = (err as { code?: string }).code
      if (code === 'name-taken') {
        return errorReply(reply, 409, 'name-taken', 'Profile name already in use')
      }
      if (code === 'role-immutable') {
        return errorReply(reply, 403, 'role-immutable', 'Cannot change the role of the household owner')
      }
      if (code === 'owner-exists') {
        return errorReply(reply, 409, 'owner-exists', 'A household owner already exists')
      }
      throw err
    }
  })

  app.delete<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
    try {
      users.delete(req.params.id)
    } catch (err) {
      if ((err as { code?: string }).code === 'owner-protected') {
        return errorReply(reply, 403, 'owner-protected', 'Cannot delete the household owner')
      }
      throw err
    }
    return reply.status(204).send()
  })
}
