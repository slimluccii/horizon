import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { errorReply, badRequest, ErrorCodes } from '../../../../platform/http/errors.ts'
import { IpRateLimiter } from '../../../../platform/http/rateLimit.ts'
import { hash as hashPassword } from '../password.ts'
import type { UserRepo } from '../persistence/userRepo.ts'
import type { SessionRepo } from '../persistence/sessionRepo.ts'
import type { HouseholdRepo } from '../persistence/householdRepo.ts'
import type { InviteRepo } from '../persistence/inviteRepo.ts'

/**
 * Invite routes: an authenticated caller mints a short, single-use code; an
 * unauthenticated guest redeems it to create their account and a session.
 *
 *  - POST /invites — authenticated. `new_household` is server owner/admin only
 *    (it spins up a brand-new isolated household). `join` adds a member to the
 *    caller's own household and is restricted to that household's owner (or a
 *    server owner/admin).
 *  - POST /invites/redeem — unauthenticated (allowlisted in authMiddleware) and
 *    per-IP rate-limited. Creates the user, sets their password, attaches them
 *    to the resolved household (and makes them its owner for `new_household`),
 *    consumes the invite, and issues a session so the guest is logged straight
 *    in. Mirrors the pairing-code shape in auth.ts.
 */

const INVITE_TTL_MS = 24 * 60 * 60 * 1000
const REDEEM_IP_MAX = 20
const RATE_WINDOW_MS = 60_000
const MIN_PASSWORD_LEN = 8

const CreateBody = z.object({ kind: z.enum(['join', 'new_household']) }).strict()
const RedeemBody = z
  .object({
    code: z.string().min(1).max(32),
    name: z.string().min(1).max(100),
    password: z.string().min(MIN_PASSWORD_LEN).max(1024),
  })
  .strict()

/** Short, human-friendly invite code (e.g. "ABCD-2345"). Avoids ambiguous
 *  characters (no 0/O/1/I), matching the pairing-code alphabet in auth.ts. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function generateInviteCode(): string {
  const pick = (n: number) =>
    Array.from(crypto.randomBytes(n), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
  return `${pick(4)}-${pick(4)}`
}

export interface InviteDeps {
  users: UserRepo
  sessions: SessionRepo
  households: HouseholdRepo
  invites: InviteRepo
}

export function registerInvites(app: FastifyInstance, deps: InviteDeps): void {
  const { users, sessions, households, invites } = deps
  const redeemLimiter = new IpRateLimiter(RATE_WINDOW_MS)

  // POST /invites — authenticated. new_household: server owner/admin only.
  // join: household owner (of the target) or server owner/admin.
  app.post('/invites', async (req, reply) => {
    const caller = req.user
    if (!caller) return errorReply(reply, 401, ErrorCodes.UNAUTHORIZED, 'Authentication required')
    const parse = CreateBody.safeParse(req.body)
    if (!parse.success) return badRequest(reply, ErrorCodes.INVALID_INPUT, parse.error.message)
    const { kind } = parse.data

    const callerUser = users.get(caller.id)
    if (!callerUser?.householdId) return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'No household')
    const isServerAdmin = caller.role === 'owner' || caller.role === 'admin'
    const household = households.get(callerUser.householdId)
    const isHouseholdOwner = household?.ownerUserId === caller.id

    if (kind === 'new_household' && !isServerAdmin) {
      return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Only server owner/admin can invite a new household')
    }
    if (kind === 'join' && !isHouseholdOwner && !isServerAdmin) {
      return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Only the household owner can invite members')
    }

    const now = Date.now()
    let code = generateInviteCode()
    for (let i = 0; i < 5; i++) {
      try {
        invites.create({
          code,
          kind,
          householdId: kind === 'join' ? callerUser.householdId : null,
          createdBy: caller.id,
          createdAt: now,
          expiresAt: now + INVITE_TTL_MS,
        })
        break
      } catch {
        code = generateInviteCode()
      }
    }
    return { code, expiresAt: now + INVITE_TTL_MS }
  })

  // POST /invites/redeem — unauthenticated, rate-limited.
  app.post('/invites/redeem', async (req, reply) => {
    if (!redeemLimiter.allow(req.ip, REDEEM_IP_MAX)) {
      return errorReply(reply, 429, ErrorCodes.RATE_LIMITED, 'Too many requests')
    }
    const parse = RedeemBody.safeParse(req.body)
    if (!parse.success) {
      const weak = parse.error.issues.some(i => i.path[0] === 'password')
      return badRequest(reply, weak ? ErrorCodes.WEAK_PASSWORD : ErrorCodes.INVALID_INPUT, parse.error.message)
    }
    const { code, name, password } = parse.data

    const inv = invites.get(code)
    if (!inv) return errorReply(reply, 404, ErrorCodes.INVITE_NOT_FOUND, 'Invite not found')
    if (inv.consumedAt != null || inv.expiresAt <= Date.now()) {
      return errorReply(reply, 410, ErrorCodes.INVITE_EXPIRED, 'Invite expired')
    }

    // Revalidate a `join` invite's authority at redeem time. The invite bakes in
    // a target household and is valid ~24h, but the authority that minted it can
    // lapse in that window. Honor it only while the minter is still authorized to
    // grow that household — mirroring POST /invites: still a server owner/admin,
    // or still the owner of the target household. Otherwise the outstanding
    // invite would inject members into a household its minter no longer controls.
    if (inv.kind === 'join') {
      const minter = users.get(inv.createdBy)
      const household = households.get(inv.householdId!)
      const minterIsServerAdmin = minter?.role === 'owner' || minter?.role === 'admin'
      // `minter &&` guards a stale owner_user_id: a deleted minter can still be
      // referenced by households.owner_user_id, so existence must be re-checked.
      const minterOwnsHousehold = !!minter && !!household && household.ownerUserId === inv.createdBy
      if (!household || (!minterIsServerAdmin && !minterOwnsHousehold)) {
        return errorReply(reply, 410, ErrorCodes.INVITE_EXPIRED, 'Invite no longer valid')
      }
    }

    // Duplicate name within the target household → 409. For `join` the target
    // household already exists, so check it up front (a read) and reject on a
    // recoverable input clash *before* burning the single-use code. A fresh
    // `new_household` has no members yet, so no clash is possible there.
    if (
      inv.kind === 'join' &&
      users.listByHousehold(inv.householdId!).some(u => u.name.toLowerCase() === name.toLowerCase())
    ) {
      return errorReply(reply, 409, ErrorCodes.NAME_TAKEN, 'Name already taken in this household')
    }

    // Hash the password BEFORE the single-use claim. Hashing (argon2) is the only
    // async step; performing it after the claim would, on a hash failure, burn the
    // code AND strand a passwordless account. Done first, every step after the
    // claim is a synchronous DB write that won't realistically throw.
    const passwordHash = await hashPassword(password)

    // Settle the single-use claim *before* creating any account or household.
    // `consume` is an atomic `UPDATE ... WHERE consumed_at IS NULL`, so of two
    // concurrent redeems of the same valid code only the one whose UPDATE flips
    // the row (changes > 0) proceeds; the loser gets 410 and never creates a
    // user, a household, or a session. The plain read-check above is only a
    // fast-path for the already-consumed/expired case — this is the real gate.
    if (!invites.consume(code, Date.now())) {
      return errorReply(reply, 410, ErrorCodes.INVITE_EXPIRED, 'Invite expired')
    }

    // Create the account first. `users.create` enforces GLOBAL case-insensitive
    // name uniqueness (not just within the target household), so a clash with a
    // user in *another* household — or any clash on the new_household path, which
    // has no members to pre-check against — surfaces only here as NAME_TAKEN.
    // That is a *recoverable* input error, so on it we must RELEASE the
    // single-use invite (reopen the row we just consumed) and return 409, never
    // burn the legitimate guest's one shot. We attach the household afterwards
    // so a failed create leaves no orphan household to clean up.
    let user
    try {
      user = users.create({ name })
    } catch (err) {
      if ((err as { code?: string }).code === ErrorCodes.NAME_TAKEN) {
        invites.release(code)
        return errorReply(reply, 409, ErrorCodes.NAME_TAKEN, 'Name already taken')
      }
      invites.release(code)
      throw err
    }

    // Resolve + attach the target household. For new_household we create it now
    // and make the redeemer its owner.
    const householdId = inv.kind === 'join' ? inv.householdId! : households.create(name, user.id).id
    users.setHousehold(user.id, householdId)

    users.setPassword(user.id, passwordHash)

    const { token } = sessions.issue(user.id, null, [user.id])
    return { token, user: users.get(user.id) }
  })
}
