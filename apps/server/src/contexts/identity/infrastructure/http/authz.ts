import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AuthedUser } from '../authMiddleware.ts'
import { badRequest, ErrorCodes } from '../../../../platform/http/errors.ts'

/**
 * Resolve the calling user from the authenticated session. Identity now comes
 * exclusively from `req.user` (set by the global `requireAuth` hook after a
 * session resolves) — the old `X-Horizon-User` header / `?user=` query hack is
 * gone. Returns the caller's id + role, or null when no session is attached
 * (only possible on allowlisted routes, which never call this).
 *
 * Kept as a thin accessor so route handlers read one helper instead of poking
 * `req.user` directly, and so the role-gate call sites stay unchanged from the
 * header era.
 */
export function resolveCallerRole(req: FastifyRequest): AuthedUser | null {
  return req.user ?? null
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
 * `caller` is the resolved `req.user` identity, or null when no session is
 * attached. A null caller can only reach headless sessions.
 */
export function canAccessSession(
  sessionUserId: string | undefined,
  caller: AuthedUser | null,
): boolean {
  if (!sessionUserId) return true
  if (!caller) return false
  if (caller.role === 'owner' || caller.role === 'admin') return true
  return caller.id === sessionUserId
}

/**
 * Ensure the authenticated caller matches the path user. Identity comes from
 * `req.user` (the session), so this no longer reads a header — but the rule is
 * unchanged from the header era: a caller may only act on their own per-user
 * resource (continue-watching, progress). Returns the path user id, or null
 * after writing a reply on failure.
 */
export function requireUser(
  req: FastifyRequest,
  reply: FastifyReply,
  pathUserId: string,
): string | null {
  const caller = req.user
  if (!caller) { badRequest(reply, ErrorCodes.NO_USER, 'Authentication required'); return null }
  if (caller.id !== pathUserId) {
    badRequest(reply, ErrorCodes.USER_MISMATCH, 'Caller does not match path user')
    return null
  }
  return pathUserId
}
