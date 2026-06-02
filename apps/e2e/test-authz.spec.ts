/**
 * Authorization e2e — user-data isolation + role gating across the live HTTP
 * surface, now over real sessions (bearer tokens) instead of the old
 * X-Horizon-User header. Complements the per-route unit tests by exercising the
 * full stack end to end.
 *
 * Preconditions: backend on :7777 with HORIZON_DEV_SEED=1 (playwright.config
 * starts it). These tests hit the API directly — no UI.
 */
import { test, expect } from '@playwright/test'
import { API, ensureOwner, createUser, bearer, seed } from './helpers/auth.ts'

test.describe('authorization', () => {
  test('unauthenticated request is rejected with 401', async ({ request }) => {
    const res = await request.get(`${API}/library/movies`)
    expect(res.status()).toBe(401)
    expect((await res.json()).code).toBe('unauthorized')
  })

  test('member cannot PATCH /settings/server (role gate)', async ({ request }) => {
    const owner = await ensureOwner(request)
    const member = await createUser(request, owner, 'Member-settings')
    const res = await request.patch(`${API}/settings/server`, {
      headers: bearer(member),
      data: { watchedThresholdPct: 80 },
    })
    expect(res.status()).toBe(403)
    expect((await res.json()).code).toBe('caller-forbidden')
  })

  test('owner can PATCH /settings/server', async ({ request }) => {
    const owner = await ensureOwner(request)
    const res = await request.patch(`${API}/settings/server`, {
      headers: bearer(owner),
      data: { watchedThresholdPct: 85 },
    })
    expect(res.status()).toBe(200)
  })

  test('member cannot start playback on behalf of another user', async ({ request }) => {
    await seed(request, 'tiny') // ensure the library has a movie
    const owner = await ensureOwner(request)
    const member = await createUser(request, owner, 'Member-playback')
    const movies = (await (await request.get(`${API}/library/movies`, { headers: bearer(member) })).json()) as { id: string }[]
    expect(movies.length).toBeGreaterThan(0)
    const res = await request.post(`${API}/sessions`, {
      headers: bearer(member),
      data: {
        mediaId: movies[0].id,
        userId: owner.id, // delegating to another user — forbidden for members
        capabilities: { videoCodecs: ['h264'], audioCodecs: ['aac'], hdr: [], maxBitrate: 1_000_000, container: ['mp4'] },
      },
    })
    expect(res.status()).toBe(403)
    expect((await res.json()).code).toBe('caller-forbidden')
  })

  test("member cannot read another user's progress", async ({ request }) => {
    const owner = await ensureOwner(request)
    const member = await createUser(request, owner, 'Member-progress')
    const res = await request.get(`${API}/users/${owner.id}/progress/anything`, {
      headers: bearer(member),
    })
    expect(res.status()).toBe(400)
    expect((await res.json()).code).toBe('user-mismatch')
  })
})
