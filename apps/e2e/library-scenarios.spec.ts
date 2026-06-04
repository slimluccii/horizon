/**
 * Library e2e against deterministic mock scenarios.
 *
 * Preconditions (playwright.config starts these):
 *   • backend on :7777 with HORIZON_DEV_SEED=1
 *   • Vite on :5173
 *
 * Each test seeds a scenario via /dev/seed, authenticates the browser as the
 * owner (session cookie), navigates to the library and asserts its state.
 * Scenarios live in apps/server/src/seed/scenarios.ts.
 *
 * Movie collections are collapsed inline in the Movies grid behind the per-user
 * `collapseMovieCollections` preference (default on). Tests that assert a flat
 * movie count set the preference off first; tests that assert collection cards
 * set it on.
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { APP, API, bearer, ensureOwner, authBrowser, seed, type SessionUser } from './helpers/auth.ts'

async function gotoLibrary(page: Page, tab?: 'movies' | 'shows') {
  await page.goto(tab ? `${APP}/?tab=${tab}` : `${APP}/`)
}

/** Set the owner's collapse-collections preference. Must run before page.goto —
 *  the web reads preferences from auth.me() at page load. */
async function setCollapse(request: APIRequestContext, owner: SessionUser, value: boolean) {
  const res = await request.patch(`${API}/users/${owner.id}`, {
    headers: bearer(owner),
    data: { preferences: { collapseMovieCollections: value } },
  })
  expect(res.ok(), `set collapseMovieCollections=${value} → ${res.status()}`).toBe(true)
}

test.describe('mock scenarios', () => {
  let owner: SessionUser

  test.beforeEach(async ({ context, request }) => {
    // Owner exists with a password; plant its session cookie in the browser so
    // the Guard lets us into the library instead of redirecting to /login.
    owner = await ensureOwner(request)
    await authBrowser(context, owner)
  })

  test('empty: shows empty-state messages on every tab', async ({ page, request }) => {
    const result = await seed(request, 'empty')
    expect(result).toMatchObject({ movies: 0, shows: 0 })

    await gotoLibrary(page, 'movies')
    await expect(page.getByText(/No movies found/i)).toBeVisible({ timeout: 10_000 })

    await page.locator('.lib__pill', { hasText: /^Series$/ }).click()
    await expect(page.getByText(/No shows found/i)).toBeVisible()
  })

  test('tiny: renders one movie + one show', async ({ page, request }) => {
    const result = await seed(request, 'tiny')
    expect(result).toMatchObject({ movies: 1, shows: 1, episodes: 1 })

    await gotoLibrary(page, 'movies')
    await expect(page.locator('[data-testid="movie-card"]')).toHaveCount(1, { timeout: 10_000 })

    await page.locator('.lib__pill', { hasText: /^Series$/ }).click()
    await expect(page.locator('[data-testid="show-card"]')).toHaveCount(1)
  })

  test('default: 24 movies, 10 shows, one collection', async ({ page, request }) => {
    const result = await seed(request, 'default')
    expect(result).toMatchObject({ movies: 24, shows: 10 })
    expect(result.collections).toBeGreaterThan(0)

    // Flat view (collapse off): all 24 movies render individually.
    await setCollapse(request, owner, false)
    await gotoLibrary(page, 'movies')
    await expect(page.locator('[data-testid="movie-card"]')).toHaveCount(24, { timeout: 15_000 })
    await expect(page.getByText('Featured · Just added')).toBeVisible()

    await page.locator('.lib__pill', { hasText: /^Series$/ }).click()
    await expect(page.locator('[data-testid="show-card"]')).toHaveCount(10)

    // Collapsed view (collapse on): the "Reyes Trilogy" set shows as one card in
    // the Movies grid, and its 3 films no longer appear standalone.
    await setCollapse(request, owner, true)
    await gotoLibrary(page, 'movies')
    const collectionCard = page.getByRole('button', { name: 'Reyes Trilogy' })
    await expect(collectionCard).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-testid="movie-card"]')).toHaveCount(21)

    // Clicking the collection opens its detail page with all 3 member films.
    await collectionCard.click()
    await expect(page).toHaveURL(/\/collection\//)
    await expect(page.locator('[data-testid="movie-card"]')).toHaveCount(3)
  })

  test('huge: 200 movies render without breaking the grid', async ({ page, request }) => {
    test.slow()
    const result = await seed(request, 'huge')
    expect(result.movies).toBe(200)
    expect(result.shows).toBe(30)

    // Perf test of the flat grid — collapse off so the count is exactly 200.
    await setCollapse(request, owner, false)
    await gotoLibrary(page, 'movies')
    await expect(page.locator('[data-testid="movie-card"]').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-testid="movie-card"]')).toHaveCount(200, { timeout: 30_000 })
  })

  test('mixed-quality: distinct quality titles render', async ({ page, request }) => {
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

  test('collections-heavy: many collection cards render inline', async ({ page, request }) => {
    const result = await seed(request, 'collections-heavy')
    expect(result.collections).toBeGreaterThan(5)

    // Collapse on (default): collections render as cards inside the Movies grid.
    await setCollapse(request, owner, true)
    await gotoLibrary(page, 'movies')
    const cards = page.locator('[data-testid="collection-card"]')
    await expect(cards.first()).toBeVisible({ timeout: 10_000 })
    expect(await cards.count()).toBeGreaterThan(5)
  })

  test('image proxy: mock poster returns a real image', async ({ request }) => {
    await seed(request, 'tiny')
    // Image proxy is unauthenticated (cacheable static-ish asset).
    const res = await request.get(`${APP}/api/metadata/image/w342/mock/poster/neon-horizon.jpg`)
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toMatch(/^image\//)
    expect((await res.body()).byteLength).toBeGreaterThan(1000)
  })
})
