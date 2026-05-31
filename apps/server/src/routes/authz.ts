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
 * Ownership/role gate for an existing session's data routes (WS, playlists,
 * segments, DELETE). The reconnectToken proves the caller knows the session,
 * but knowledge of a token is not the same as the right to use it — a member
 * must not be able to ride someone else's session even with the token.
 *
 * Rules:
 *  - A headless session (userId unset) is accessible to anyone — there is no
 *    owner to protect, matching the progress-flush no-op contract.
 *  - owner/admin may access any session (household-wide control).
 *  - a member may access only a session they own (caller.id === userId).
 *
 * `caller` is the resolved X-Horizon-User identity, or null when the header is
 * absent/unknown. A null caller can only reach headless sessions.
 */
export function canAccessSession(
  sessionUserId: string | undefined,
  caller: { id: string; role: 'owner' | 'admin' | 'member' } | null,
): boolean {
  if (!sessionUserId) return true
  if (!caller) return false
  if (caller.role === 'owner' || caller.role === 'admin') return true
  return caller.id === sessionUserId
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
