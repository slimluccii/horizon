// Identity context — public surface.
// Users, roles, passwords, auth sessions, pairing, and the auth HTTP adapters.
export {
  createUserRepo,
  type UserRepo,
  type User,
  type UserAuth,
  type UserInsert,
  type UserPatch,
} from './infrastructure/persistence/userRepo.ts'
export {
  createSessionRepo,
  type SessionRepo,
  type Session,
  type PairingCode,
} from './infrastructure/persistence/sessionRepo.ts'
export { hash, verify } from './infrastructure/password.ts'
export {
  makeRequireAuth,
  SESSION_COOKIE,
  setSessionCookie,
  tokenFromRequest,
  isAllowlisted,
  isHttps,
  type AuthedUser,
  AUTH_ALLOWLIST,
  AUTH_ALLOWLIST_PREFIXES,
  AUTH_ALLOWLIST_BY_METHOD,
} from './infrastructure/authMiddleware.ts'
export { registerAuth } from './infrastructure/http/auth.ts'
export { registerUsers } from './infrastructure/http/users.ts'
export { resolveCallerRole, requireUser, canAccessSession } from './infrastructure/http/authz.ts'
