import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ErrorCodes } from '@horizon/sdk'
import { errorReply, badRequest, sendNotFound } from '../../../../platform/http/errors.ts'
import type { UserRepo } from '../persistence/userRepo.ts'
import type { HouseholdRepo } from '../persistence/householdRepo.ts'

const RenameBody = z.object({ name: z.string().min(1).max(100) }).strict()

export function registerHouseholds(
  app: FastifyInstance,
  deps: { users: UserRepo; households: HouseholdRepo },
): void {
  const { users, households } = deps

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
    return { id, name: parse.data.name, ownerUserId: household.ownerUserId }
  })
}
