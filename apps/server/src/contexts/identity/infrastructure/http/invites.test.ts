import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { openDatabase, type DatabaseSync } from '../../../../platform/db/connection.ts'
import { migrate } from '../../../../platform/db/migrations.ts'
import { createUserRepo } from '../persistence/userRepo.ts'
import { createSessionRepo } from '../persistence/sessionRepo.ts'
import { createHouseholdRepo } from '../persistence/householdRepo.ts'
import { createInviteRepo } from '../persistence/inviteRepo.ts'
import { ensureHouseholds } from '../../domain/household.ts'
import { makeRequireAuth } from '../authMiddleware.ts'
import { registerInvites } from './invites.ts'
import fastifyCookie from '@fastify/cookie'

async function makeApp() {
  const db: DatabaseSync = openDatabase(':memory:')
  migrate(db)
  const users = createUserRepo(db)
  const sessions = createSessionRepo(db)
  const households = createHouseholdRepo(db)
  const invites = createInviteRepo(db)
  const owner = users.create({ name: 'Owner' }) // auto owner (first user)
  ensureHouseholds(db)
  const ownerToken = sessions.issue(owner.id).token

  const app = Fastify()
  await app.register(fastifyCookie)   // redeem sets the hz_session cookie (prod: registerAuth does this)
  app.addHook('onRequest', makeRequireAuth(sessions, users))
  registerInvites(app, { users, sessions, households, invites })
  await app.ready()
  return { app, db, users, sessions, households, invites, owner, ownerToken }
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` }
}

describe('invites', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>
  beforeEach(async () => {
    ctx = await makeApp()
  })

  it('owner creates a new_household invite, friend redeems → own household + ownership', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/invites',
      headers: auth(ctx.ownerToken),
      payload: { kind: 'new_household' },
    })
    expect(create.statusCode).toBe(200)
    const code = create.json().code as string

    const redeem = await ctx.app.inject({
      method: 'POST',
      url: '/invites/redeem',
      payload: { code, name: 'Friend', password: 'hunter2hunter' },
    })
    expect(redeem.statusCode).toBe(200)
    expect(redeem.json().token).toBeTruthy()
    // Web redeemer rides the httpOnly session cookie — it must be set, like login.
    expect(String(redeem.headers['set-cookie'])).toContain('hz_session')
    const friendId = redeem.json().user.id as string
    const friend = ctx.users.get(friendId)!
    const ownerHousehold = ctx.users.get(ctx.owner.id)!.householdId
    expect(friend.householdId).not.toBe(ownerHousehold) // isolated household
    expect(ctx.households.get(friend.householdId!)!.ownerUserId).toBe(friendId) // redeemer owns it
  })

  it('a member cannot create a new_household invite (403)', async () => {
    const memberId = ctx.users.create({
      name: 'Member',
      householdId: ctx.users.get(ctx.owner.id)!.householdId,
    }).id
    const memberToken = ctx.sessions.issue(memberId).token
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/invites',
      headers: auth(memberToken),
      payload: { kind: 'new_household' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('household owner creates a join invite; redeemer joins the same household', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/invites',
      headers: auth(ctx.ownerToken),
      payload: { kind: 'join' },
    })
    expect(create.statusCode).toBe(200)
    const code = create.json().code as string

    const redeem = await ctx.app.inject({
      method: 'POST',
      url: '/invites/redeem',
      payload: { code, name: 'Partner', password: 'hunter2hunter' },
    })
    expect(redeem.statusCode).toBe(200)
    const partner = ctx.users.get(redeem.json().user.id as string)!
    const ownerHousehold = ctx.users.get(ctx.owner.id)!.householdId
    expect(partner.householdId).toBe(ownerHousehold) // same household
    expect(partner.role).toBe('member')
  })

  it('a member cannot create a join invite (403)', async () => {
    const memberId = ctx.users.create({
      name: 'Member',
      householdId: ctx.users.get(ctx.owner.id)!.householdId,
    }).id
    const memberToken = ctx.sessions.issue(memberId).token
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/invites',
      headers: auth(memberToken),
      payload: { kind: 'join' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('redeem of an unknown code → 404 invite-not-found', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/invites/redeem',
      payload: { code: 'NOPE-0000', name: 'X', password: 'longenough12' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('invite-not-found')
  })

  it('redeem of a consumed invite → 410 invite-expired', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/invites',
      headers: auth(ctx.ownerToken),
      payload: { kind: 'new_household' },
    })
    const code = create.json().code as string
    ctx.invites.consume(code, Date.now())

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/invites/redeem',
      payload: { code, name: 'Late', password: 'hunter2hunter' },
    })
    expect(res.statusCode).toBe(410)
    expect(res.json().code).toBe('invite-expired')
  })

  it('redeem of an expired invite → 410 invite-expired', async () => {
    const code = 'EXPR-DOLD'
    ctx.invites.create({
      code,
      kind: 'new_household',
      householdId: null,
      createdBy: ctx.owner.id,
      createdAt: Date.now() - 2000,
      expiresAt: Date.now() - 1000, // already in the past
    })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/invites/redeem',
      payload: { code, name: 'Late', password: 'hunter2hunter' },
    })
    expect(res.statusCode).toBe(410)
    expect(res.json().code).toBe('invite-expired')
  })

  it('new_household redeem with a globally-taken name → 409, invite not burned', async () => {
    // `users.create` enforces GLOBAL case-insensitive name uniqueness, not just
    // within the target household. A new_household invite has no members to
    // pre-check against, so the collision only surfaces inside `users.create`.
    // The handler must map it to 409 AND keep the single-use invite redeemable
    // so the guest can retry with a different name — never burn it on a
    // recoverable input clash.
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/invites',
      headers: auth(ctx.ownerToken),
      payload: { kind: 'new_household' },
    })
    const code = create.json().code as string

    // 'Owner' already exists (the auto-elected first user) in a different
    // household, so this name collides globally.
    const clash = await ctx.app.inject({
      method: 'POST',
      url: '/invites/redeem',
      payload: { code, name: 'owner', password: 'hunter2hunter' },
    })
    expect(clash.statusCode).toBe(409)
    expect(clash.json().code).toBe('name-taken')

    // The invite survived: the guest retries with a free name and succeeds.
    const retry = await ctx.app.inject({
      method: 'POST',
      url: '/invites/redeem',
      payload: { code, name: 'Newcomer', password: 'hunter2hunter' },
    })
    expect(retry.statusCode).toBe(200)
    const newId = retry.json().user.id as string
    expect(ctx.households.get(ctx.users.get(newId)!.householdId!)!.ownerUserId).toBe(newId)
  })

  it('join redeem with a name taken in another household → 409, invite not burned', async () => {
    // Even for `join`, the up-front listByHousehold pre-check only catches
    // clashes WITHIN the target household. A name taken in a *different*
    // household still trips global uniqueness inside `users.create`, so the
    // handler must catch it, return 409, and leave the invite redeemable.
    const other = ctx.users.create({ name: 'Outsider' }) // separate household
    const otherHh = ctx.households.create('Other', other.id)
    ctx.users.setHousehold(other.id, otherHh.id)

    const create = await ctx.app.inject({
      method: 'POST',
      url: '/invites',
      headers: auth(ctx.ownerToken),
      payload: { kind: 'join' },
    })
    const code = create.json().code as string

    const clash = await ctx.app.inject({
      method: 'POST',
      url: '/invites/redeem',
      payload: { code, name: 'outsider', password: 'hunter2hunter' },
    })
    expect(clash.statusCode).toBe(409)
    expect(clash.json().code).toBe('name-taken')

    const retry = await ctx.app.inject({
      method: 'POST',
      url: '/invites/redeem',
      payload: { code, name: 'Partner', password: 'hunter2hunter' },
    })
    expect(retry.statusCode).toBe(200)
    const partner = ctx.users.get(retry.json().user.id as string)!
    expect(partner.householdId).toBe(ctx.users.get(ctx.owner.id)!.householdId)
  })

  it('redeem over the per-IP rate limit → 429', async () => {
    // The limiter only counts attempts that reach it (before body parsing /
    // invite lookup), so a flood of unknown-code redeems still exhausts it.
    let got429 = false
    for (let i = 0; i < 25; i++) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/invites/redeem',
        payload: { code: `MISS-${i}`, name: 'X', password: 'longenough12' },
      })
      if (res.statusCode === 429) {
        expect(res.json().code).toBe('rate-limited')
        got429 = true
        break
      }
    }
    expect(got429).toBe(true)
  })

  // --- join-invite minter revalidation (follow-up B) -----------------------
  // Build a second household J owned by a server-role member `mo`, and a join
  // invite for J minted by `mo`.
  function householdJ() {
    const mo = ctx.users.create({ name: 'MO' })            // server role member
    const hj = ctx.households.create('J', mo.id)
    ctx.users.setHousehold(mo.id, hj.id)
    const now = Date.now()
    ctx.invites.create({ code: 'JOIN-9', kind: 'join', householdId: hj.id, createdBy: mo.id, createdAt: now, expiresAt: now + 60_000 })
    return { mo, hj }
  }

  it('rejects a join redeem once the minter no longer owns the household (410)', async () => {
    const { hj } = householdJ()
    // Ownership transfers away from the minter (mo), who is a plain server member.
    ctx.households.setOwner(hj.id, ctx.owner.id)
    const res = await ctx.app.inject({
      method: 'POST', url: '/invites/redeem',
      payload: { code: 'JOIN-9', name: 'Guest', password: 'longenough12' },
    })
    expect(res.statusCode).toBe(410)
    expect(res.json().code).toBe('invite-expired')
    // No user was injected into J.
    expect(ctx.users.listByHousehold(hj.id).some(u => u.name === 'Guest')).toBe(false)
  })

  // Note: a "minter deleted" case is not reachable — invites.created_by is a NOT
  // NULL FK to users(id), so an outstanding invite pins its minter's row. The
  // realistic authority lapse is an ownership transfer (above). The implementation
  // still re-checks minter existence defensively.

  it('still honors a join invite while the minter remains the household owner (200)', async () => {
    householdJ() // mo still owns J
    const res = await ctx.app.inject({
      method: 'POST', url: '/invites/redeem',
      payload: { code: 'JOIN-9', name: 'Guest', password: 'longenough12' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('still honors a join invite minted by a server owner/admin who is not the household owner (200)', async () => {
    const { hj } = householdJ()
    // Re-mint the J invite as the SERVER OWNER (ctx.owner), who does not own J.
    const now = Date.now()
    ctx.invites.create({ code: 'JOIN-ADM', kind: 'join', householdId: hj.id, createdBy: ctx.owner.id, createdAt: now, expiresAt: now + 60_000 })
    const res = await ctx.app.inject({
      method: 'POST', url: '/invites/redeem',
      payload: { code: 'JOIN-ADM', name: 'Guest2', password: 'longenough12' },
    })
    expect(res.statusCode).toBe(200)
  })
})
