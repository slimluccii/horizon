import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { openDatabase, type DatabaseSync } from '../../../../platform/db/connection.ts'
import { migrate } from '../../../../platform/db/migrations.ts'
import { createUserRepo } from '../persistence/userRepo.ts'
import { createSessionRepo } from '../persistence/sessionRepo.ts'
import { createHouseholdRepo } from '../persistence/householdRepo.ts'
import { ensureHouseholds } from '../../domain/household.ts'
import { makeRequireAuth } from '../authMiddleware.ts'
import { registerHouseholds } from './households.ts'

async function makeApp() {
  const db: DatabaseSync = openDatabase(':memory:')
  migrate(db)
  const users = createUserRepo(db); const sessions = createSessionRepo(db); const households = createHouseholdRepo(db)
  const owner = users.create({ name: 'Owner' }); ensureHouseholds(db)
  users.create({ name: 'Partner', householdId: users.get(owner.id)!.householdId })
  const token = sessions.issue(owner.id).token
  const app = Fastify()
  app.addHook('onRequest', makeRequireAuth(sessions, users))
  registerHouseholds(app, { users, households })
  await app.ready()
  return { app, owner, token, users, sessions, households }
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` })

describe('households', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>
  beforeEach(async () => { ctx = await makeApp() })

  it('GET /households/me returns the household + its members', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/households/me', headers: auth(ctx.token) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.members.map((m: any) => m.name).sort()).toEqual(['Owner', 'Partner'])
    expect(body.ownerUserId).toBe(ctx.owner.id)
  })

  it('PATCH /households/:id rename by the owner', async () => {
    const id = ctx.users.get(ctx.owner.id)!.householdId!
    const res = await ctx.app.inject({ method: 'PATCH', url: `/households/${id}`, headers: auth(ctx.token), payload: { name: 'Living Room' } })
    expect(res.statusCode).toBe(200)
    expect(ctx.households.get(id)!.name).toBe('Living Room')
    const body = res.json()
    expect(body).toMatchObject({ id, name: 'Living Room', ownerUserId: ctx.owner.id })
    expect(body.members.map((m: any) => m.name).sort()).toEqual(['Owner', 'Partner'])
  })

  it('PATCH /households/:id rename by a non-owner member → 403 caller-forbidden', async () => {
    const householdId = ctx.users.get(ctx.owner.id)!.householdId!
    const member = ctx.users.create({ name: 'Member', householdId })
    const memberToken = ctx.sessions.issue(member.id).token
    const res = await ctx.app.inject({ method: 'PATCH', url: `/households/${householdId}`, headers: auth(memberToken), payload: { name: 'Hijacked' } })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('caller-forbidden')
  })

  it('PATCH /households/:id on an unknown id → 404 not-found', async () => {
    const res = await ctx.app.inject({ method: 'PATCH', url: '/households/does-not-exist', headers: auth(ctx.token), payload: { name: 'X' } })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('not-found')
  })
})
