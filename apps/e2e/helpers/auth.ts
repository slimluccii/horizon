import { type APIRequestContext, type BrowserContext, type Page, expect } from '@playwright/test'

export const APP = 'http://localhost:5173'
export const API = 'http://localhost:7777/api'

/**
 * E2E auth helpers for the post-auth world: there is no X-Horizon-User header
 * any more — every request authenticates via a session (httpOnly cookie for the
 * browser, `Authorization: Bearer` for API-only request contexts).
 *
 * The first profile created on an empty DB is the auto-elected owner, and that
 * first POST /users issues a bootstrap session (cookie + token). We use it to
 * set the owner password, then mint further sessions via /auth/login.
 */

export interface SessionUser {
  id: string
  name: string
  role: 'owner' | 'admin' | 'member'
  token: string
}

/** Default password used for every e2e account. */
export const PASSWORD = 'e2e-password-123'

/**
 * Ensure an owner exists with a known password and return a bearer session for
 * it. Safe to call when the household is already set up (falls back to login).
 */
export async function ensureOwner(request: APIRequestContext, name = 'Owner'): Promise<SessionUser> {
  const list = (await (await request.get(`${API}/users`)).json()) as Array<{ id: string; name: string; role: SessionUser['role']; hasPassword?: boolean }>
  if (list.length === 0) {
    // First-boot: create owner (issues a bootstrap session token), set password.
    const created = await (await request.post(`${API}/users`, { data: { name } })).json() as { id: string; token: string }
    await request.post(`${API}/auth/set-password`, {
      headers: { authorization: `Bearer ${created.token}` },
      data: { newPassword: PASSWORD },
    })
    const login = await loginApi(request, name)
    return login
  }
  // Already set up — log in as the existing owner.
  const owner = list.find(u => u.role === 'owner') ?? list[0]
  return loginApi(request, owner.name)
}

/** Create a member (or admin) profile with a password, as an authenticated
 *  owner/admin caller, and return a bearer session for it. */
export async function createUser(
  request: APIRequestContext,
  owner: SessionUser,
  name: string,
  opts: { role?: 'admin' | 'member' } = {},
): Promise<SessionUser> {
  const created = await (await request.post(`${API}/users`, {
    headers: bearer(owner),
    data: { name },
  })).json() as { id: string }
  // Owner sets the new user's password (reset path: no old password needed).
  await request.post(`${API}/auth/set-password`, {
    headers: bearer(owner),
    data: { userId: created.id, newPassword: PASSWORD },
  })
  if (opts.role === 'admin') {
    await request.patch(`${API}/users/${created.id}`, { headers: bearer(owner), data: { role: 'admin' } })
  }
  return loginApi(request, name)
}

/** Log in via the API and return a bearer session. */
export async function loginApi(request: APIRequestContext, name: string, password = PASSWORD): Promise<SessionUser> {
  const res = await request.post(`${API}/auth/login`, { data: { name, password } })
  expect(res.ok(), `login ${name} → ${res.status()}`).toBe(true)
  const body = await res.json() as { token: string; user: { id: string; name: string; role: SessionUser['role'] } }
  return { id: body.user.id, name: body.user.name, role: body.user.role, token: body.token }
}

/** Authorization header for an API-only request as this user. */
export function bearer(u: SessionUser): Record<string, string> {
  return { authorization: `Bearer ${u.token}` }
}

/**
 * Make the BROWSER authenticated as `user` by planting the session cookie. The
 * server's cookie is httpOnly + issued server-side, so we reuse the bearer token
 * as the cookie value (the server accepts the same opaque token from either
 * transport). Call before navigating.
 */
export async function authBrowser(context: BrowserContext, user: SessionUser): Promise<void> {
  await context.addCookies([{
    name: 'hz_session',
    value: user.token,
    domain: 'localhost',
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
  }])
}

/** Seed a deterministic library scenario (requires HORIZON_DEV_SEED=1). */
export async function seed(request: APIRequestContext, scenario: string): Promise<{ movies: number; shows: number; episodes: number; collections: number }> {
  const res = await request.post(`${API}/dev/seed/${scenario}`)
  expect(res.ok(), `seed /dev/seed/${scenario} → ${res.status()} (HORIZON_DEV_SEED=1?)`).toBe(true)
  return res.json()
}

/**
 * Point the library at a real movies directory and rescan, then wait until at
 * least one movie is indexed (rescan is fire-and-forget, so we poll). Uses the
 * owner session. Returns the indexed movie list. Used by the playback specs to
 * index the synthetic fixture clip via the real ffprobe scan path.
 */
export async function scanMoviesRoot(
  request: APIRequestContext,
  owner: SessionUser,
  moviesRoot: string,
  timeoutMs = 30_000,
): Promise<Array<{ id: string; title: string }>> {
  const patch = await request.patch(`${API}/settings/server`, {
    headers: bearer(owner),
    data: { moviesRoots: [moviesRoot] },
  })
  expect(patch.ok(), `set moviesRoots → ${patch.status()}`).toBe(true)

  await request.post(`${API}/library/rescan`, { headers: bearer(owner), data: {} })

  const deadline = Date.now() + timeoutMs
  for (;;) {
    const movies = (await (await request.get(`${API}/library/movies`, { headers: bearer(owner) })).json()) as Array<{ id: string; title: string }>
    if (movies.length > 0) return movies
    if (Date.now() > deadline) {
      throw new Error(`No movies indexed under ${moviesRoot} within ${timeoutMs}ms`)
    }
    await new Promise(r => setTimeout(r, 500))
  }
}

/** Log in through the UI login page (profile picker + password). */
export async function loginUi(page: Page, name: string, password = PASSWORD): Promise<void> {
  await page.goto(`${APP}/login`)
  await page.getByRole('button', { name }).click()
  await page.getByPlaceholder('Password').fill(password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page).not.toHaveURL(/\/login$/)
}
