/**
 * Library e2e against deterministic mock scenarios.
 *
 * Preconditions:
 *   • Horizon server running on :7777 with HORIZON_DEV_SEED=1
 *     (e.g. `HORIZON_DEV_SEED=1 HORIZON_DB_PATH=/tmp/horizon-e2e.db npm run dev:server`)
 *   • Playwright auto-starts Vite on :5173
 *
 * Each test:
 *   1. POSTs /dev/seed/:scenario to the backend → wipes + loads fixtures
 *   2. Seeds a user so the app doesn't redirect to /setup
 *   3. Navigates to /
 *   4. Asserts library state for that scenario
 *
 * Scenarios live in server/src/seed/scenarios.ts.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

const APP = 'http://localhost:5173'

async function ensureUser(request: APIRequestContext): Promise<string> {
  const list = await request.get(`${APP}/users`)
  let users = (await list.json()) as { id: string }[]
  if (users.length === 0) {
    await request.post(`${APP}/users`, { data: { name: 'E2E', avatar: '🦊' } })
    const refresh = await request.get(`${APP}/users`)
    users = (await refresh.json()) as { id: string }[]
  }
  return users[0].id
}

async function seed(request: APIRequestContext, scenario: string) {
  const res = await request.post(`${APP}/dev/seed/${scenario}`)
  expect(res.ok(), `seed /dev/seed/${scenario} → ${res.status()}. Is HORIZON_DEV_SEED=1?`).toBe(true)
  return res.json() as Promise<{ scenario: string; movies: number; shows: number; episodes: number; collections: number }>
}

async function gotoLibrary(page: Page, tab?: 'movies' | 'shows' | 'collections') {
  const url = tab ? `${APP}/?tab=${tab}` : `${APP}/`
  await page.goto(url)
}

test.describe('mock scenarios', () => {
  test.beforeEach(async ({ context, request }) => {
    const userId = await ensureUser(request)
    // Skip the profile-picker by pre-setting localStorage on every navigation.
    await context.addInitScript(id => {
      try { window.localStorage.setItem('horizonUser', id) } catch { /* ignored */ }
    }, userId)
  })

  test('empty: shows empty-state messages on every tab', async ({ page, request }) => {
    const result = await seed(request, 'empty')
    expect(result).toMatchObject({ scenario: 'empty', movies: 0, shows: 0 })

    await gotoLibrary(page, 'movies')
    await expect(page.getByText(/No movies found/i)).toBeVisible({ timeout: 10_000 })

    await page.locator('.lib__pill', { hasText: /^Series$/ }).click()
    await expect(page.getByText(/No shows found/i)).toBeVisible()

    await page.locator('.lib__pill', { hasText: /^Collections$/ }).click()
    await expect(page.getByText(/No collections detected/i)).toBeVisible()
  })

  test('tiny: renders one movie + one show', async ({ page, request }) => {
    const result = await seed(request, 'tiny')
    expect(result).toMatchObject({ scenario: 'tiny', movies: 1, shows: 1, episodes: 1 })

    await gotoLibrary(page, 'movies')
    await expect(page.locator('[data-testid="movie-card"]')).toHaveCount(1, { timeout: 10_000 })

    await page.locator('.lib__pill', { hasText: /^Series$/ }).click()
    await expect(page.locator('[data-testid="show-card"]')).toHaveCount(1)
  })

  test('default: 24 movies, 10 shows, one collection', async ({ page, request }) => {
    const result = await seed(request, 'default')
    expect(result).toMatchObject({ scenario: 'default', movies: 24, shows: 10 })
    expect(result.collections).toBeGreaterThan(0)

    await gotoLibrary(page, 'movies')
    await expect(page.locator('[data-testid="movie-card"]')).toHaveCount(24, { timeout: 15_000 })
    // Hero rendered for the first movie that has a backdrop
    await expect(page.getByText('Featured · Just added')).toBeVisible()

    await page.locator('.lib__pill', { hasText: /^Series$/ }).click()
    await expect(page.locator('[data-testid="show-card"]')).toHaveCount(10)

    await page.locator('.lib__pill', { hasText: /^Collections$/ }).click()
    await expect(page.getByText('Reyes Trilogy')).toBeVisible()
  })

  test('huge: 200 movies render without breaking the grid', async ({ page, request }) => {
    test.slow()  // grid + image proxy warm-up
    const result = await seed(request, 'huge')
    expect(result.movies).toBe(200)
    expect(result.shows).toBe(30)

    await gotoLibrary(page, 'movies')
    // Grid should mount within a reasonable budget
    await expect(page.locator('[data-testid="movie-card"]').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-testid="movie-card"]')).toHaveCount(200, { timeout: 30_000 })
  })

  test('mixed-quality: every poster has a distinct title (quality badges exercised)', async ({ page, request }) => {
    const result = await seed(request, 'mixed-quality')
    expect(result.movies).toBe(8)

    await gotoLibrary(page, 'movies')
    await expect(page.locator('[data-testid="movie-card"]')).toHaveCount(8, { timeout: 10_000 })
    for (const title of [
      'SDR 1080p H.264',
      'HDR10 4K HEVC',
      'HDR10+ 4K HEVC',
      'Dolby Vision 4K HEVC',
      'Dolby Vision 4K AV1',
    ]) {
      await expect(page.getByRole('button', { name: title })).toBeVisible()
    }
  })

  test('collections-heavy: many collection rails render', async ({ page, request }) => {
    const result = await seed(request, 'collections-heavy')
    expect(result.collections).toBeGreaterThan(5)

    await gotoLibrary(page, 'collections')
    const headings = page.locator('.lib__collection-title')
    await expect(headings.first()).toBeVisible({ timeout: 10_000 })
    const count = await headings.count()
    expect(count).toBeGreaterThan(5)
  })

  test('image proxy: mock poster returns a real image', async ({ request }) => {
    await seed(request, 'tiny')
    const res = await request.get(`${APP}/metadata/image/w342/mock/poster/neon-horizon.jpg`)
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toMatch(/^image\//)
    const buf = await res.body()
    expect(buf.byteLength).toBeGreaterThan(1000)
  })
})
