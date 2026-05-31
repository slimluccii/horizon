import { describe, it, expect } from 'vitest'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createUserRepo } from '../src/repos/users.ts'
import { resolveCallerRole, requireUser } from '../src/routes/authz.ts'

function setup() {
  const db = openDatabase(':memory:'); migrate(db)
  const users = createUserRepo(db)
  const user = users.create({ name: 'Luuk' })
  return { users, user }
}

/** Minimal FastifyRequest stub carrying only the headers authz reads. */
function req(headers: Record<string, unknown>): FastifyRequest {
  return { headers } as unknown as FastifyRequest
}

/** Reply stub that records the last status + body written. */
function makeReply() {
  const state: { status?: number; body?: { error: string; code: string } } = {}
  const reply = {
    status(code: number) { state.status = code; return reply },
    send(body: { error: string; code: string }) { state.body = body; return reply },
  } as unknown as FastifyReply
  return { reply, state }
}

describe('resolveCallerRole', () => {
  it('returns null when header missing', () => {
    const { users } = setup()
    expect(resolveCallerRole(users, req({}))).toBeNull()
  })

  it('returns null when header is not a string', () => {
    const { users } = setup()
    expect(resolveCallerRole(users, req({ 'x-horizon-user': ['a', 'b'] }))).toBeNull()
  })

  it('returns null for unknown user id', () => {
    const { users } = setup()
    expect(resolveCallerRole(users, req({ 'x-horizon-user': 'nope' }))).toBeNull()
  })

  it('returns {id, role} for a valid user id', () => {
    const { users, user } = setup()
    expect(resolveCallerRole(users, req({ 'x-horizon-user': user.id }))).toEqual({
      id: user.id,
      role: user.role,
    })
  })
})

describe('requireUser', () => {
  it('replies 400 no-user and returns null when header missing', () => {
    const { users, user } = setup()
    const { reply, state } = makeReply()
    expect(requireUser(users, req({}), reply, user.id)).toBeNull()
    expect(state.status).toBe(400)
    expect(state.body?.code).toBe('no-user')
  })

  it('replies 400 user-mismatch when header user differs from path user', () => {
    const { users, user } = setup()
    const { reply, state } = makeReply()
    expect(requireUser(users, req({ 'x-horizon-user': user.id }), reply, 'other')).toBeNull()
    expect(state.status).toBe(400)
    expect(state.body?.code).toBe('user-mismatch')
  })

  it('replies 400 no-user when user does not exist', () => {
    const { users } = setup()
    const { reply, state } = makeReply()
    expect(requireUser(users, req({ 'x-horizon-user': 'ghost' }), reply, 'ghost')).toBeNull()
    expect(state.status).toBe(400)
    expect(state.body?.code).toBe('no-user')
  })

  it('returns the userId when header present and matches an existing path user', () => {
    const { users, user } = setup()
    const { reply, state } = makeReply()
    expect(requireUser(users, req({ 'x-horizon-user': user.id }), reply, user.id)).toBe(user.id)
    expect(state.status).toBeUndefined()
  })
})
