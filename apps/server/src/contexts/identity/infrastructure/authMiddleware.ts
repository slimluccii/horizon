import type { FastifyReply, FastifyRequest } from 'fastify'
import { ErrorCodes } from '@horizon/sdk'
import type { SessionRepo } from './persistence/sessionRepo.ts'
import type { UserRepo } from './persistence/userRepo.ts'

/** Name of the httpOnly session cookie set on web logins. */
export const SESSION_COOKIE = 'hz_session'

/** Is this request running over TLS (so the cookie may be marked Secure)? We
 *  trust X-Forwarded-Proto because the documented deployment is behind a TLS
 *  reverse proxy; a direct-TLS listener also reports `req.protocol === 'https'`. */
export function isHttps(req: FastifyRequest): boolean {
  const xfp = req.headers['x-forwarded-proto']
  const proto = Array.isArray(xfp) ? xfp[0] : xfp
  if (proto) return proto.split(',')[0].trim() === 'https'
  return req.protocol === 'https'
}

/** Set the session cookie. SameSite=Lax so it rides top-level navigations +
 *  media subresource loads (`<video>`, `<track>`, WS upgrade) while staying off
 *  cross-site POSTs. Shared by the auth routes and the first-boot owner create. */
export function setSessionCookie(reply: FastifyReply, req: FastifyRequest, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps(req),
    path: '/',
  })
}

/**
 * Identity attached to a request once a session resolves. Routes read this
 * instead of the old `X-Horizon-User` header / `resolveCallerRole`.
 */
export interface AuthedUser {
  id: string
  role: 'owner' | 'admin' | 'member'
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `makeRequireAuth` after a session resolves; undefined on
     *  allowlisted (unauthenticated) routes. */
    user?: AuthedUser
    /** Active profile (X-Horizon-Profile), validated against the session grant. */
    profileUserId?: string
  }
}

/**
 * Paths that skip authentication. The login/pairing-start/pairing-poll routes
 * must be reachable without a session (you cannot have one yet), `/health` is
 * an unauthenticated liveness probe, and the static web assets are served to
 * the login page itself. Everything else requires a session.
 *
 * Exact matches are checked against the request path; prefixes (trailing `/`)
 * match any path under them (static assets, nested routes).
 */
export const AUTH_ALLOWLIST: ReadonlyArray<string> = [
  '/health',
  '/auth/login',
  '/auth/pair/start',
  '/auth/pair/poll',
  '/invites/redeem',
]

/** Prefixes under which every path is unauthenticated.
 *  - `/assets/` — static web bundle, served to the login page itself.
 *  - `/dev/` — the destructive dev-seed routes. These ONLY exist when
 *    HORIZON_DEV_SEED=1 (registered conditionally in server.ts, and the startup
 *    guard forbids that flag in production), so allowlisting the prefix can't
 *    expose anything in a real deployment; it lets e2e seed without a session. */
export const AUTH_ALLOWLIST_PREFIXES: ReadonlyArray<string> = [
  '/assets/',
  '/dev/',
  // Poster/backdrop image proxy. Served to <img> tags (which can't send a
  // bearer) and to external caches; the content is non-secret artwork keyed by
  // opaque TMDB/mock paths, so it's safe to leave unauthenticated.
  '/metadata/',
]

/**
 * Method-specific exemptions. `GET /users` lists profiles (names + avatars only,
 * no secrets) and MUST be reachable pre-login: the first-run Guard reads it to
 * decide setup-vs-login, and the login page renders the profile picker from it
 * (the Plex/Jellyfin "who's watching" screen). The mutating verbs on /users are
 * NOT exempt — creating/editing/deleting still requires a session (POST /users
 * has its own first-boot empty-household bypass in server.ts).
 */
export const AUTH_ALLOWLIST_BY_METHOD: Readonly<Record<string, ReadonlyArray<string>>> = {
  GET: ['/users'],
}

/** Is `path` exempt from auth? Compares against the route path (no query). When
 *  `method` is given, also honours the per-method allowlist (e.g. GET /users).
 *
 *  The guard runs inside the `/api` plugin, so route paths arrive prefixed
 *  (`/api/auth/login`); the allowlist entries are written unprefixed, so we
 *  strip a leading `/api` first. This also lets the server unit tests register
 *  routes WITHOUT the prefix and still exercise the same allowlist. */
export function isAllowlisted(path: string, method?: string): boolean {
  const p = path === '/api' ? '/' : path.startsWith('/api/') ? path.slice(4) : path
  if (AUTH_ALLOWLIST.includes(p)) return true
  if (AUTH_ALLOWLIST_PREFIXES.some(prefix => p.startsWith(prefix))) return true
  if (method) {
    const forMethod = AUTH_ALLOWLIST_BY_METHOD[method.toUpperCase()]
    if (forMethod?.includes(p)) return true
  }
  return false
}

/**
 * Read the opaque session token from a request: the `hz_session` cookie first
 * (web), then `Authorization: Bearer <token>` (native clients). Returns null
 * when neither is present.
 *
 * `req.cookies` is populated when `@fastify/cookie` is registered; if it is
 * absent we parse the raw `Cookie` header so the helper works standalone in
 * tests and before the plugin is wired.
 */
export function tokenFromRequest(req: FastifyRequest): string | null {
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies
  const fromCookie = cookies?.[SESSION_COOKIE] ?? parseCookieHeader(req.headers.cookie)[SESSION_COOKIE]
  if (fromCookie) return fromCookie
  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim()
    if (token) return token
  }
  return null
}

/** Minimal `Cookie:` header parser for the standalone (no-plugin) path. */
function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const name = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (name) out[name] = decodeURIComponent(value)
  }
  return out
}

/**
 * Build a Fastify `onRequest`/`preHandler` hook that authenticates every
 * non-allowlisted request. On success it sets `req.user = { id, role }`; on a
 * missing/expired session (or a session whose user no longer exists) it replies
 * 401 `unauthorized` and the route never runs.
 *
 * Not wired into `server.ts` here — that happens in a later phase. This module
 * just provides the hook factory + allowlist so the wiring is a one-liner.
 */
export function makeRequireAuth(sessionRepo: SessionRepo, userRepo: UserRepo) {
  return async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (isAllowlisted(req.routeOptions?.url ?? req.url.split('?')[0], req.method)) return
    const token = tokenFromRequest(req)
    if (!token) {
      await reply.status(401).send({ error: 'Authentication required', code: ErrorCodes.UNAUTHORIZED })
      return
    }
    const session = sessionRepo.resolve(token)
    if (!session) {
      await reply.status(401).send({ error: 'Authentication required', code: ErrorCodes.UNAUTHORIZED })
      return
    }
    const user = userRepo.get(session.userId)
    if (!user) {
      // Session outlived its user (deleted mid-flight) — treat as unauthenticated.
      await reply.status(401).send({ error: 'Authentication required', code: ErrorCodes.UNAUTHORIZED })
      return
    }
    req.user = { id: user.id, role: user.role }
  }
}

/** Header carrying the active profile (act-as target) for a request. */
export const PROFILE_HEADER = 'x-horizon-profile'

/**
 * Build a preHandler (runs after requireAuth) that resolves the ACTIVE PROFILE.
 * Reads X-Horizon-Profile; with no header the active profile is the principal.
 * Otherwise the target must be in the session's grant, else 403. The session is
 * re-resolved by token to read its grant (the principal is already known from
 * requireAuth, but the grant lives on the session).
 */
export function makeResolveProfile(sessionRepo: SessionRepo, userRepo: UserRepo) {
  return async function resolveProfile(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!req.user) return // allowlisted routes never set req.user; nothing to resolve
    const raw = req.headers[PROFILE_HEADER]
    const target = Array.isArray(raw) ? raw[0] : raw
    if (!target) { req.profileUserId = req.user.id; return }

    const token = tokenFromRequest(req)
    const session = token ? sessionRepo.resolve(token) : null
    const grant = session?.grant ?? [req.user.id]
    // The target must be in the grant AND still share the principal's household.
    // The household re-check is defense-in-depth: a grant is captured at pairing
    // and frozen on a 90-day session, so without it a profile later moved to
    // another household could still be acted on cross-household. GET /auth/grant
    // applies the same household intersection — enforcement must match display.
    const principal = userRepo.get(req.user.id)
    const targetUser = userRepo.get(target)
    if (!grant.includes(target) || !targetUser || targetUser.householdId !== principal?.householdId) {
      await reply.status(403).send({ error: 'Profile not granted', code: ErrorCodes.PROFILE_NOT_GRANTED })
      return
    }
    req.profileUserId = target
  }
}
