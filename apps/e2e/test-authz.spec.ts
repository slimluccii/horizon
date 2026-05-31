/**
 * Authorization e2e — verifies user-data isolation and role gating across the
 * HTTP surface. Complements the per-route unit tests (routes.sessions.test.ts,
 * routes.settings.test.ts, routes.library.test.ts) by exercising the live
 * server end to end through the SDK transport (raw fetch via Playwright's
 * request context).
 *
 * Preconditions:
 *   • Horizon server running on :7777 with HORIZON_DEV_SEED=1
 *   • These tests hit the API directly (no UI), so they only need the backend.
 *
 * Covered cases (issue #30 — POST /sessions authorization bypass + role gating):
 *   1. member cannot PATCH /settings/server                       → 403
 *   2. member cannot start playback for another user (userId)     → 403
 *   3. member GET of another user's progress                      → 400 user-mismatch
 *   4. owner/admin can PATCH /settings/server                     → 200
 */
import { test, expect, type APIRequestContext } from '@playwright/test'

const API = 'http://localhost:7777'

interface SeededUser {
  id: string
  role: 'owner' | 'admin' | 'member'
}

/** Wipe existing users by recreating the household: the first user created is
 *  always the owner; subsequent users default to member. */
async function freshUsers(request: APIRequestContext): Promise<{ owner: SeededUser; member: SeededUser }> {
  // Reset to a known scenario so the DB has media but a clean slate to read.
  await request.post(`${API}/dev/seed/tiny`).catch(() => undefined)

  const existing = (await (await request.get(`${API}/users`)).json()) as SeededUser[]
  let owner = existing.find(u => u.role === 'owner') ?? null
  if (!owner) {
    const res = await request.post(`${API}/users`, { data: { name: 'Owner', avatar: '🦊' } })
    owner = (await res.json()) as SeededUser
  }
  // A second account is always a member.
  const memberRes = await request.post(`${API}/users`, { data: { name: 'Member', avatar: '🐼' } })
  const member = (await memberRes.json()) as SeededUser
  return { owner, member }
}

test.describe('authorization', () => {
  test('member cannot PATCH /settings/server (role gate)', async ({ request }) => {
    const { member } = await freshUsers(request)
    const res = await request.patch(`${API}/settings/server`, {
      headers: { 'x-horizon-user': member.id },
      data: { watchedThresholdPct: 80 },
    })
    expect(res.status()).toBe(403)
    expect((await res.json()).code).toBe('caller-forbidden')
  })

  test('owner can PATCH /settings/server', async ({ request }) => {
    const { owner } = await freshUsers(request)
    const res = await request.patch(`${API}/settings/server`, {
      headers: { 'x-horizon-user': owner.id },
      data: { watchedThresholdPct: 85 },
    })
    expect(res.status()).toBe(200)
  })

  test('member cannot start playback on behalf of another user', async ({ request }) => {
    const { owner, member } = await freshUsers(request)
    const movies = (await (await request.get(`${API}/library/movies`, {
      headers: { 'x-horizon-user': member.id },
    })).json()) as { id: string }[]
    expect(movies.length).toBeGreaterThan(0)
    const res = await request.post(`${API}/sessions`, {
      headers: { 'x-horizon-user': member.id },
      data: {
        mediaId: movies[0].id,
        userId: owner.id, // delegating to another user — forbidden for members
        capabilities: { videoCodecs: ['h264'], audioCodecs: ['aac'], hdr: [], maxBitrate: 1_000_000, container: ['mp4'] },
      },
    })
    expect(res.status()).toBe(403)
    expect((await res.json()).code).toBe('caller-forbidden')
  })

  test('member cannot read another user\'s progress', async ({ request }) => {
    const { owner, member } = await freshUsers(request)
    const res = await request.get(`${API}/users/${owner.id}/progress/anything`, {
      headers: { 'x-horizon-user': member.id },
    })
    expect(res.status()).toBe(400)
    expect((await res.json()).code).toBe('user-mismatch')
  })
})
