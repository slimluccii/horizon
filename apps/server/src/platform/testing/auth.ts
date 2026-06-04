import type { FastifyInstance } from 'fastify'
import type { DatabaseSync } from '../db/connection.ts'
import { createUserRepo, type UserRepo, type User } from '../../contexts/identity/index.ts'
import { createSessionRepo, type SessionRepo } from '../../contexts/identity/index.ts'
import { makeRequireAuth } from '../../contexts/identity/index.ts'

/**
 * Shared test plumbing for the session-based auth cutover. Route tests no longer
 * send an `X-Horizon-User` header; instead they register the real `requireAuth`
 * hook on their throwaway app and authenticate each request with a Bearer token
 * minted from a real session (`asUser(token)`), exactly as a native client would.
 *
 * The hook sets `req.user`, which every route handler now reads via
 * `resolveCallerRole(req)` / `requireUser`.
 */

export interface AuthFixture {
  users: UserRepo
  sessions: SessionRepo
  /** Create a user and issue a session; returns the user + its raw bearer token. */
  makeUser(name: string, role?: 'owner' | 'admin' | 'member'): { user: User; token: string }
  /** Issue an additional session token for an existing user. */
  tokenFor(userId: string): string
}

/** Build repos for the session-auth fixture against an already-migrated db. */
export function authFixture(db: DatabaseSync): AuthFixture {
  const users = createUserRepo(db)
  const sessions = createSessionRepo(db)
  return {
    users,
    sessions,
    makeUser(name, role) {
      const user = users.create({ name })
      // create() auto-elects the first user owner; promote/demote if asked.
      const finalRole = role ?? user.role
      if (finalRole !== user.role && finalRole !== 'owner') {
        users.update(user.id, { role: finalRole })
      }
      const fresh = users.get(user.id)!
      const token = sessions.issue(user.id).token
      return { user: fresh, token }
    },
    tokenFor(userId) {
      return sessions.issue(userId).token
    },
  }
}

/** Install the production auth guard hook on a test app. */
export function installAuth(app: FastifyInstance, sessions: SessionRepo, users: UserRepo): void {
  app.addHook('onRequest', makeRequireAuth(sessions, users))
}

/** Authorization header carrying a session bearer token. */
export function asUser(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` }
}
