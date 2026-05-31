import type { FastifyReply, FastifyRequest } from 'fastify'
import type { UserRepo } from '../repos/users.ts'
import { badRequest, ErrorCodes } from './errors.ts'

/**
 * Resolve the calling user from the X-Horizon-User header.
 * Returns the user's id + role, or null if the header is absent, not a
 * string, or does not resolve to an existing user. Callers decide how to
 * handle null (e.g. reply 400 / 403).
 */
export function resolveCallerRole(
  users: UserRepo,
  req: FastifyRequest,
): { id: string; role: 'owner' | 'admin' | 'member' } | null {
  const hdr = req.headers['x-horizon-user']
  const id = typeof hdr === 'string' ? hdr : null
  if (!id) return null
  const u = users.get(id)
  return u ? { id: u.id, role: u.role } : null
}

/**
 * Ensure the active-user header is present + matches the path user + resolves
 * to an existing row. Returns null and writes a reply on failure.
 */
export function requireUser(
  users: UserRepo,
  req: FastifyRequest,
  reply: FastifyReply,
  pathUserId: string,
): string | null {
  const hdr = req.headers['x-horizon-user']
  const id = typeof hdr === 'string' ? hdr : null
  if (!id) { badRequest(reply, ErrorCodes.NO_USER, 'Missing X-Horizon-User header'); return null }
  if (id !== pathUserId) { badRequest(reply, ErrorCodes.USER_MISMATCH, 'Header user does not match path'); return null }
  if (!users.get(id)) { badRequest(reply, ErrorCodes.NO_USER, 'User not found'); return null }
  return id
}
