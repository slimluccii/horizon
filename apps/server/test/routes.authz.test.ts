import { describe, it, expect } from 'vitest'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { resolveCallerRole, requireUser, canAccessSession } from '../src/routes/authz.ts'
import type { AuthedUser } from '../src/auth/middleware.ts'

/** Minimal FastifyRequest stub carrying only `req.user` (set by the auth hook). */
function req(user?: AuthedUser): FastifyRequest {
  return { user } as unknown as FastifyRequest
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

const owner: AuthedUser = { id: 'u-owner', role: 'owner' }
const member: AuthedUser = { id: 'u-member', role: 'member' }

describe('resolveCallerRole', () => {
  it('returns null when no session is attached', () => {
    expect(resolveCallerRole(req())).toBeNull()
  })

  it('returns the attached req.user', () => {
    expect(resolveCallerRole(req(owner))).toEqual(owner)
  })
})

describe('requireUser', () => {
  it('replies 400 no-user and returns null when unauthenticated', () => {
    const { reply, state } = makeReply()
    expect(requireUser(req(), reply, 'u-owner')).toBeNull()
    expect(state.status).toBe(400)
    expect(state.body?.code).toBe('no-user')
  })

  it('replies 400 user-mismatch when caller differs from path user', () => {
    const { reply, state } = makeReply()
    expect(requireUser(req(member), reply, 'other')).toBeNull()
    expect(state.status).toBe(400)
    expect(state.body?.code).toBe('user-mismatch')
  })

  it('returns the path user id when caller matches', () => {
    const { reply, state } = makeReply()
    expect(requireUser(req(owner), reply, 'u-owner')).toBe('u-owner')
    expect(state.status).toBeUndefined()
  })
})

describe('canAccessSession', () => {
  it('allows anyone on a headless session', () => {
    expect(canAccessSession(undefined, null)).toBe(true)
    expect(canAccessSession(undefined, member)).toBe(true)
  })

  it('rejects a null caller on an owned session', () => {
    expect(canAccessSession('u-member', null)).toBe(false)
  })

  it('lets owner/admin reach any session', () => {
    expect(canAccessSession('u-member', owner)).toBe(true)
  })

  it('lets a member reach only their own session', () => {
    expect(canAccessSession('u-member', member)).toBe(true)
    expect(canAccessSession('u-other', member)).toBe(false)
  })
})
