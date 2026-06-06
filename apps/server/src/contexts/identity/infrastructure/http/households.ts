import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { ErrorCodes } from '@horizon/sdk'
import { errorReply, badRequest, sendNotFound } from '../../../../platform/http/errors.ts'
import type { UserRepo } from '../persistence/userRepo.ts'
import type { HouseholdRepo } from '../persistence/householdRepo.ts'

const RenameBody = z.object({ name: z.string().min(1).max(100) }).strict()
const DeleteBody = z.object({ deleteMembers: z.boolean() }).strict()

export function registerHouseholds(
  app: FastifyInstance,
  deps: { users: UserRepo; households: HouseholdRepo },
): void {
  const { users, households } = deps

  function requireServerAdmin(req: FastifyRequest, reply: FastifyReply): { id: string; role: 'owner' | 'admin' | 'member' } | null {
    const caller = req.user
    if (!caller) { errorReply(reply, 401, ErrorCodes.UNAUTHORIZED, 'Authentication required'); return null }
    if (caller.role !== 'owner' && caller.role !== 'admin') {
      errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Server owner/admin only'); return null
    }
    return caller
  }

  app.get('/households', async (req, reply) => {
    if (!requireServerAdmin(req, reply)) return
    return households.list().map(h => ({
      id: h.id, name: h.name, ownerUserId: h.ownerUserId, members: users.listByHousehold(h.id),
    }))
  })

  app.get('/households/me', async (req, reply) => {
    const caller = req.user
    if (!caller) return errorReply(reply, 401, ErrorCodes.UNAUTHORIZED, 'Authentication required')
    const me = users.get(caller.id)
    if (!me?.householdId) return errorReply(reply, 404, ErrorCodes.NOT_FOUND, 'No household')
    const household = households.get(me.householdId)
    if (!household) return sendNotFound(reply, ErrorCodes.NOT_FOUND, 'Household not found')
    return {
      id: household.id,
      name: household.name,
      ownerUserId: household.ownerUserId,
      members: users.listByHousehold(household.id),
    }
  })

  app.delete('/households/:id', async (req, reply) => {
    if (!requireServerAdmin(req, reply)) return
    const id = (req.params as { id: string }).id
    const parse = DeleteBody.safeParse(req.body)
    if (!parse.success) return badRequest(reply, ErrorCodes.INVALID_INPUT, parse.error.message)
    if (!households.get(id)) return sendNotFound(reply, ErrorCodes.NOT_FOUND, 'Household not found')
    if (households.hasServerOwner(id)) {
      return errorReply(reply, 409, ErrorCodes.OWNER_PROTECTED, 'Cannot delete the server owner’s household')
    }
    if (parse.data.deleteMembers) households.deleteCascade(id)
    else households.deleteOrphaning(id)
    return reply.status(204).send()
  })

  app.patch('/households/:id', async (req, reply) => {
    const caller = req.user
    if (!caller) return errorReply(reply, 401, ErrorCodes.UNAUTHORIZED, 'Authentication required')
    const id = (req.params as { id: string }).id
    const parse = RenameBody.safeParse(req.body)
    if (!parse.success) return badRequest(reply, ErrorCodes.INVALID_INPUT, parse.error.message)
    const household = households.get(id)
    if (!household) return sendNotFound(reply, ErrorCodes.NOT_FOUND, 'Household not found')
    const isServerAdmin = caller.role === 'owner' || caller.role === 'admin'
    if (household.ownerUserId !== caller.id && !isServerAdmin) {
      return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Only the household owner can rename it')
    }
    households.rename(id, parse.data.name)
    return {
      id,
      name: parse.data.name,
      ownerUserId: household.ownerUserId,
      members: users.listByHousehold(id),
    }
  })
}
