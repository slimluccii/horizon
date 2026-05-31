import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { UserRepo } from '../repos/users.ts'
import { sendNotFound, badRequest, errorReply, ErrorCodes } from './errors.ts'
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
    if (!parse.success) return badRequest(reply, ErrorCodes.INVALID_INPUT, parse.error.message)
    // First-boot exemption: unauthenticated creation is allowed only while the
    // household is empty (the first user is auto-elected owner). Once any user
    // exists, creating further profiles requires an owner/admin caller.
    const isEmptyDatabase = users.list().length === 0
    if (!isEmptyDatabase) {
      const caller = resolveCallerRole(users, req)
      if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Cannot create user without authentication')
      if (caller.role === 'member') return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Only owner or admin can create users')
    }
    try {
      const { preferences, ...rest } = parse.data
      return users.create({
        ...rest,
        ...(preferences !== undefined ? { preferences: preferences as Record<string, unknown> } : {}),
      })
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === ErrorCodes.NAME_TAKEN) {
        return errorReply(reply, 409, ErrorCodes.NAME_TAKEN, 'Profile name already in use')
      }
      if (code === ErrorCodes.OWNER_EXISTS) {
        return errorReply(reply, 409, ErrorCodes.OWNER_EXISTS, 'A household owner already exists')
      }
      throw err
    }
  })

  app.get('/users', async () => users.list())

  app.get<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
    const u = users.get(req.params.id)
    if (!u) return sendNotFound(reply, ErrorCodes.USER_NOT_FOUND, 'User not found')
    return u
  })

  app.patch<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
    const parse = PatchBody.safeParse(req.body)
    if (!parse.success) return badRequest(reply, ErrorCodes.INVALID_INPUT, parse.error.message)
    if (parse.data.role !== undefined) {
      const caller = resolveCallerRole(users, req)
      if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Missing or unknown X-Horizon-User header')
      if (caller.role === 'member') return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Only owner or admin can change roles')
    }
    try {
      const { preferences, ...rest } = parse.data
      let updateData: typeof parse.data = rest
      if (preferences !== undefined) {
        const existing = users.get(req.params.id)
        if (!existing) return sendNotFound(reply, ErrorCodes.USER_NOT_FOUND, 'User not found')
        updateData = { ...rest, preferences: { ...existing.preferences, ...preferences } }
      }
      const u = users.update(req.params.id, updateData)
      if (!u) return sendNotFound(reply, ErrorCodes.USER_NOT_FOUND, 'User not found')
      return u
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === ErrorCodes.NAME_TAKEN) {
        return errorReply(reply, 409, ErrorCodes.NAME_TAKEN, 'Profile name already in use')
      }
      if (code === ErrorCodes.ROLE_IMMUTABLE) {
        return errorReply(reply, 403, ErrorCodes.ROLE_IMMUTABLE, 'Cannot change the role of the household owner')
      }
      if (code === ErrorCodes.OWNER_EXISTS) {
        return errorReply(reply, 409, ErrorCodes.OWNER_EXISTS, 'A household owner already exists')
      }
      throw err
    }
  })

  app.delete<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
    try {
      users.delete(req.params.id)
    } catch (err) {
      if ((err as { code?: string }).code === ErrorCodes.OWNER_PROTECTED) {
        return errorReply(reply, 403, ErrorCodes.OWNER_PROTECTED, 'Cannot delete the household owner')
      }
      throw err
    }
    return reply.status(204).send()
  })
}
