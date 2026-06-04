import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import fastifyCookie from '@fastify/cookie'
import crypto from 'node:crypto'
import type { UserRepo } from '../persistence/userRepo.ts'
import type { SessionRepo } from '../persistence/sessionRepo.ts'
import { SESSION_COOKIE, tokenFromRequest, setSessionCookie } from '../authMiddleware.ts'
import { hash as hashPassword, verify as verifyPassword } from '../password.ts'
import { badRequest, errorReply, ErrorCodes } from '../../../../platform/http/errors.ts'
import { IpRateLimiter } from '../../../../platform/http/rateLimit.ts'

/**
 * Built-in authentication routes: login/logout/me, self-service + admin
 * set-password, and the TV device-pairing flow. Identity for every other route
 * flows from the session this module issues; the global `requireAuth` hook in
 * server.ts reads it back off the `hz_session` cookie or `Authorization: Bearer`.
 *
 * Security posture (see the auth design doc):
 *  - Passwords are Argon2id (scrypt fallback), verified in ~100ms.
 *  - Login is throttled per-IP AND per-account, with a progressive lockout on
 *    top, and returns a single generic error so a probe cannot distinguish a
 *    bad username from a bad password (no user enumeration).
 *  - The session cookie is httpOnly + SameSite=Lax, and Secure whenever the
 *    request arrived over TLS (X-Forwarded-Proto: https behind a reverse proxy).
 *  - Pairing codes are short-lived, single-use, and only an authenticated user
 *    can approve one.
 */

// --- Tuning constants -------------------------------------------------------

/** Failed logins allowed before the first lockout kicks in. */
const LOCKOUT_THRESHOLD = 5
/** First lockout duration; doubles each additional failure past the threshold. */
const LOCKOUT_BASE_MS = 60_000
/** Cap the exponential lockout so it never runs away (≈ 17 min at 2^4). */
const LOCKOUT_MAX_MS = 60_000 * 16

/** Per-IP login attempts allowed per window. Strict by default; overridable via
 *  HORIZON_LOGIN_IP_MAX for e2e (which logs in many times from one IP). The
 *  per-account lockout below is the real brute-force defence and is NOT relaxed. */
const LOGIN_IP_MAX = (() => {
  const raw = process.env.HORIZON_LOGIN_IP_MAX
  const n = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : 20
})()
/** Per-IP pairing attempts (start/approve/poll) allowed per window. */
const PAIR_IP_MAX = 60
/** Shared rate-limit window. */
const RATE_WINDOW_MS = 60_000

/** Pairing-code lifetime (~10 min). */
const PAIR_TTL_MS = 10 * 60_000

/** Minimum acceptable password length. Argon2 has no practical max. */
const MIN_PASSWORD_LEN = 8

// --- Schemas ----------------------------------------------------------------

const LoginBody = z.object({
  name: z.string().min(1).max(100),
  password: z.string().min(1).max(1024),
}).strict()

const SetPasswordBody = z.object({
  /** Target user; defaults to the caller (self-service). */
  userId: z.string().optional(),
  /** Required for a self-service change once the caller already has a password. */
  oldPassword: z.string().min(1).max(1024).optional(),
  newPassword: z.string().min(MIN_PASSWORD_LEN).max(1024),
}).strict()

const PairApproveBody = z.object({ code: z.string().min(1).max(32) }).strict()
const PairPollBody = z.object({ code: z.string().min(1).max(32) }).strict()

// --- Helpers ----------------------------------------------------------------

/** Compute the lockout deadline for a given failed-attempt count, or null when
 *  still under the threshold. Exponential past the threshold, capped. */
function lockoutDeadline(failedAttempts: number, now: number): number | null {
  if (failedAttempts < LOCKOUT_THRESHOLD) return null
  const over = failedAttempts - LOCKOUT_THRESHOLD
  const dur = Math.min(LOCKOUT_BASE_MS * 2 ** over, LOCKOUT_MAX_MS)
  return now + dur
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' })
}

/** The single generic login failure — never reveals whether the name or the
 *  password was wrong. */
function genericLoginFailure(reply: FastifyReply): FastifyReply {
  return errorReply(reply, 401, ErrorCodes.INVALID_CREDENTIALS, 'Invalid name or password')
}

/** Short, human-friendly pairing code (e.g. "ABCD-1234"). Avoids ambiguous
 *  characters (no 0/O/1/I) so it reads cleanly off a TV screen. */
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function generatePairingCode(): string {
  const pick = (n: number) =>
    Array.from(crypto.randomBytes(n), b => PAIR_ALPHABET[b % PAIR_ALPHABET.length]).join('')
  return `${pick(4)}-${pick(4)}`
}

// --- Registration -----------------------------------------------------------

export async function registerAuth(
  app: FastifyInstance,
  users: UserRepo,
  sessions: SessionRepo,
): Promise<void> {
  await app.register(fastifyCookie)

  const loginLimiter = new IpRateLimiter(RATE_WINDOW_MS)
  const pairLimiter = new IpRateLimiter(RATE_WINDOW_MS)

  // POST /auth/login — unauthenticated (allowlisted). Verifies the password,
  // issues a session, and sets the cookie + returns the raw token for native
  // clients. Per-IP + per-account throttle + progressive lockout.
  app.post('/auth/login', async (req, reply) => {
    if (!loginLimiter.allow(req.ip, LOGIN_IP_MAX)) {
      return errorReply(reply, 429, ErrorCodes.RATE_LIMITED, 'Too many requests')
    }
    const parse = LoginBody.safeParse(req.body)
    if (!parse.success) return genericLoginFailure(reply)
    const { name, password } = parse.data

    const auth = users.getAuthByName(name)
    // No such user, or no password set yet: generic failure (no enumeration).
    // We still cannot leak "set a password first" here — the web setup flow
    // drives unmigrated owners through set-password via a separate path.
    if (!auth || !auth.passwordHash) {
      // Spend roughly the same time as a real verify to blunt timing oracles.
      await verifyPassword('scrypt$1$1$1$AA==$AA==', password).catch(() => false)
      return genericLoginFailure(reply)
    }

    const now = Date.now()
    if (auth.lockedUntil && auth.lockedUntil > now) {
      return errorReply(reply, 429, ErrorCodes.ACCOUNT_LOCKED, 'Account temporarily locked')
    }

    const ok = await verifyPassword(auth.passwordHash, password)
    if (!ok) {
      const attempts = users.recordFailedLogin(auth.id, lockoutDeadline(auth.failedAttempts + 1, now))
      if (attempts >= LOCKOUT_THRESHOLD) {
        return errorReply(reply, 429, ErrorCodes.ACCOUNT_LOCKED, 'Account temporarily locked')
      }
      return genericLoginFailure(reply)
    }

    users.clearLockout(auth.id)
    const ua = req.headers['user-agent']
    const { token } = sessions.issue(auth.id, typeof ua === 'string' ? ua : null)
    setSessionCookie(reply, req, token)
    const user = users.get(auth.id)
    return { token, user }
  })

  // POST /auth/logout — revoke the current session + clear the cookie.
  app.post('/auth/logout', async (req, reply) => {
    const token = tokenFromRequest(req)
    if (token) {
      const s = sessions.resolve(token)
      if (s) sessions.revoke(s.id)
    }
    clearSessionCookie(reply)
    return { ok: true }
  })

  // POST /auth/logout-all — revoke every session for the caller.
  app.post('/auth/logout-all', async (req, reply) => {
    const caller = req.user
    if (!caller) return errorReply(reply, 401, ErrorCodes.UNAUTHORIZED, 'Authentication required')
    const revoked = sessions.revokeAllForUser(caller.id)
    clearSessionCookie(reply)
    return { revoked }
  })

  // GET /auth/me — the SDK's identity source.
  app.get('/auth/me', async (req, reply) => {
    const caller = req.user
    if (!caller) return errorReply(reply, 401, ErrorCodes.UNAUTHORIZED, 'Authentication required')
    const user = users.get(caller.id)
    if (!user) return errorReply(reply, 401, ErrorCodes.UNAUTHORIZED, 'Authentication required')
    return user
  })

  // POST /auth/set-password — self (with old password once one is set) OR
  // owner/admin resetting another user (no old password). First-boot owner is
  // forced through here: a caller whose own password_set_at is null may set
  // their own password without an old one.
  app.post('/auth/set-password', async (req, reply) => {
    const caller = req.user
    if (!caller) return errorReply(reply, 401, ErrorCodes.UNAUTHORIZED, 'Authentication required')
    const parse = SetPasswordBody.safeParse(req.body)
    if (!parse.success) {
      // Surface the weak-password case explicitly; everything else is invalid input.
      const tooShort = parse.error.issues.some(i => i.path[0] === 'newPassword')
      return badRequest(reply, tooShort ? ErrorCodes.WEAK_PASSWORD : ErrorCodes.INVALID_INPUT, parse.error.message)
    }
    const { userId, oldPassword, newPassword } = parse.data
    const targetId = userId ?? caller.id
    const isSelf = targetId === caller.id

    const callerAuth = users.getAuthById(caller.id)
    if (!callerAuth) return errorReply(reply, 401, ErrorCodes.UNAUTHORIZED, 'Authentication required')

    if (isSelf) {
      // First-boot / never-set: no old password required. Otherwise the caller
      // must prove knowledge of the current password.
      if (callerAuth.passwordSetAt != null) {
        if (!oldPassword) return badRequest(reply, ErrorCodes.PASSWORD_REQUIRED, 'Current password required')
        const ok = callerAuth.passwordHash
          ? await verifyPassword(callerAuth.passwordHash, oldPassword)
          : false
        if (!ok) return errorReply(reply, 401, ErrorCodes.INVALID_CREDENTIALS, 'Current password is incorrect')
      }
    } else {
      // Admin reset of another user: owner/admin only, no old password needed.
      if (caller.role === 'member') {
        return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Only owner or admin can reset another user')
      }
      if (!users.getAuthById(targetId)) {
        return errorReply(reply, 404, ErrorCodes.USER_NOT_FOUND, 'User not found')
      }
    }

    const hashed = await hashPassword(newPassword)
    users.setPassword(targetId, hashed)
    // A password change/reset invalidates other sessions for that user — they
    // must re-login with the new password. Keep the caller's own session when
    // it's a self-change so they aren't logged out mid-flight.
    sessions.revokeAllForUser(targetId)
    if (isSelf) {
      const ua = req.headers['user-agent']
      const { token } = sessions.issue(targetId, typeof ua === 'string' ? ua : null)
      setSessionCookie(reply, req, token)
      return { token, user: users.get(targetId) }
    }
    return { ok: true }
  })

  // --- Pairing flow ---------------------------------------------------------

  // POST /auth/pair/start — unauthenticated (allowlisted), rate-limited. The TV
  // calls this, displays the returned code, then polls.
  app.post('/auth/pair/start', async (req, reply) => {
    if (!pairLimiter.allow(req.ip, PAIR_IP_MAX)) {
      return errorReply(reply, 429, ErrorCodes.RATE_LIMITED, 'Too many requests')
    }
    const now = Date.now()
    const expiresAt = now + PAIR_TTL_MS
    // Retry a couple of times on the rare code collision.
    let code = generatePairingCode()
    for (let i = 0; i < 5; i++) {
      try {
        sessions.createPairingCode(code, now, expiresAt)
        break
      } catch {
        code = generatePairingCode()
      }
    }
    return { code, expiresAt }
  })

  // POST /auth/pair/approve — authenticated. The phone/web user approves a code
  // shown on the TV; we bind their identity to it so the TV's poll can mint a
  // session for them.
  app.post('/auth/pair/approve', async (req, reply) => {
    const caller = req.user
    if (!caller) return errorReply(reply, 401, ErrorCodes.UNAUTHORIZED, 'Authentication required')
    const parse = PairApproveBody.safeParse(req.body)
    if (!parse.success) return badRequest(reply, ErrorCodes.INVALID_INPUT, parse.error.message)
    const pc = sessions.getPairingCode(parse.data.code)
    if (!pc) return errorReply(reply, 404, ErrorCodes.PAIRING_NOT_FOUND, 'Pairing code not found')
    if (pc.consumed || pc.expiresAt <= Date.now()) {
      return errorReply(reply, 410, ErrorCodes.PAIRING_EXPIRED, 'Pairing code expired')
    }
    sessions.approvePairingCode(parse.data.code, caller.id)
    return { ok: true }
  })

  // POST /auth/pair/poll — unauthenticated (allowlisted). The TV polls until the
  // code is approved; the first successful poll issues a session and consumes
  // the code. 410 once expired/consumed.
  app.post('/auth/pair/poll', async (req, reply) => {
    if (!pairLimiter.allow(req.ip, PAIR_IP_MAX)) {
      return errorReply(reply, 429, ErrorCodes.RATE_LIMITED, 'Too many requests')
    }
    const parse = PairPollBody.safeParse(req.body)
    if (!parse.success) return badRequest(reply, ErrorCodes.INVALID_INPUT, parse.error.message)
    const pc = sessions.getPairingCode(parse.data.code)
    if (!pc) return errorReply(reply, 404, ErrorCodes.PAIRING_NOT_FOUND, 'Pairing code not found')
    if (pc.consumed || pc.expiresAt <= Date.now()) {
      return errorReply(reply, 410, ErrorCodes.PAIRING_EXPIRED, 'Pairing code expired')
    }
    if (!pc.approvedUserId) {
      // Still waiting for the phone to approve.
      return reply.status(202).send({ status: 'pending' })
    }
    const ua = req.headers['user-agent']
    const { token, session } = sessions.issue(pc.approvedUserId, typeof ua === 'string' ? ua : null)
    sessions.consumePairingCode(parse.data.code, session.id)
    return { token, user: users.get(pc.approvedUserId) }
  })
}
