/**
 * E2E playback test — real transcode against a real library.
 *
 * Playback can't be faked: the mock seed scenarios use placeholder file paths,
 * so ffmpeg has nothing to spawn on. These tests therefore require an actual
 * playable library and are SKIPPED when none is present (e.g. CI with no media):
 * the beforeAll authenticates the browser as the owner, then probes for a movie
 * whose card renders; if the library is empty the whole suite is skipped rather
 * than failing.
 *
 * To run them locally: point a dev backend at real media (scan a folder via the
 * Settings UI or a media mount), then `npx playwright test playback`.
 *
 * Backend on :7777, Vite on :5173 (playwright.config).
 */

import { test, expect, type Page, type ConsoleMessage } from '@playwright/test'
import { ensureOwner, authBrowser, APP } from './helpers/auth.ts'

// Real transcode needs real files; the mock seed scenarios render movie cards
// but their file paths don't exist, so ffmpeg can't spawn. Gate the whole suite
// on an explicit opt-in flag set only when a real, scannable library is wired up.
const REAL_MEDIA = process.env.HORIZON_E2E_REAL_MEDIA === '1'

// Authenticate every browser context as the owner before each test.
test.beforeEach(async ({ context, request, page }) => {
  test.skip(!REAL_MEDIA, 'Set HORIZON_E2E_REAL_MEDIA=1 with a real library to run playback e2e')
  const owner = await ensureOwner(request)
  await authBrowser(context, owner)
  await page.goto(`${APP}/?tab=movies`)
})

// Collect 404 errors on HLS segment / init-segment requests — these indicate
// broken URL construction in the server's playlist rewriting.
function collectSegment404s(page: Page): () => string[] {
  const errors: string[] = []
  page.on('response', res => {
    const url = res.url()
    if (
      res.status() === 404 &&
      (url.includes('/renditions/') || url.includes('/sessions/'))
    ) {
      errors.push(`404 ${url}`)
    }
  })
  return () => errors
}

// Collect fatal console errors (ignore React / router deprecation warnings)
function collectFatalErrors(page: Page): () => string[] {
  const errors: string[] = []
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      const text = msg.text()
      // Ignore benign browser noise
      if (
        text.includes('Download the React DevTools') ||
        text.includes('React Router Future Flag')
      ) return
      errors.push(text)
    }
  })
  return () => errors
}

test('library loads and lists at least one movie', async ({ page }) => {
  await page.goto('/')
  const cards = page.locator('[data-testid="movie-card"]')
  await expect(cards.first()).toBeVisible({ timeout: 15_000 })
})

test('clicking a movie starts playback without 404 errors', async ({ page }) => {
  const get404s = collectSegment404s(page)
  const getFatalErrors = collectFatalErrors(page)

  // Log all session-related responses for debugging
  page.on('response', res => {
    const url = res.url()
    if (url.includes('/sessions/')) {
      console.log(`[net] ${res.status()} ${res.request().method()} ${url.replace(/.*\/sessions\/[^/]+/, '/sessions/<id>')}`)
    }
  })

  await page.goto('/')

  // Find first movie card and click it
  // Try common selectors; adapt if the Library component uses different markup
  const firstCard = page.locator('[data-testid="movie-card"]').first()
  await expect(firstCard).toBeVisible({ timeout: 15_000 })
  await firstCard.click()

  // Should navigate to /player/:id
  await expect(page).toHaveURL(/\/play\//, { timeout: 10_000 })

  // Loading overlay visible initially
  const loadingText = page.getByText('Starting playback…')

  // Wait for loading overlay to disappear — session-ready fired
  await expect(loadingText).not.toBeVisible({ timeout: 60_000 })

  // <video> should now be in the DOM and playing
  const video = page.locator('video')
  await expect(video).toBeVisible({ timeout: 10_000 })

  // Poll until currentTime advances past 0 — proves segments decoded & played
  await expect(async () => {
    const currentTime = await video.evaluate((el: HTMLVideoElement) => el.currentTime)
    expect(currentTime).toBeGreaterThan(0)
  }).toPass({ timeout: 30_000, intervals: [1_000] })

  // Verify no looping: currentTime must advance by ≥8s over the next 12s.
  // A looping video would have currentTime ≤ one segment duration (~4s).
  const t0 = await video.evaluate((el: HTMLVideoElement) => el.currentTime)
  await page.waitForTimeout(12_000)
  const t1 = await video.evaluate((el: HTMLVideoElement) => el.currentTime)
  console.log(`[playback] currentTime: ${t0.toFixed(2)}s → ${t1.toFixed(2)}s (delta ${(t1 - t0).toFixed(2)}s)`)
  expect(t1 - t0).toBeGreaterThan(8) // must advance ≥8s in 12s window (accounting for buffering)

  // Assert no broken HLS segment 404s occurred during the whole test
  const segment404s = get404s()
  expect(
    segment404s,
    `HLS segment 404s detected:\n${segment404s.join('\n')}`,
  ).toHaveLength(0)

  // No fatal JS errors
  const fatalErrors = getFatalErrors()
  expect(
    fatalErrors,
    `Fatal console errors:\n${fatalErrors.join('\n')}`,
  ).toHaveLength(0)
})

test('rapid quality changes preserve correct playback position', async ({ page }) => {
  // Probes the resumeAtSec lifecycle (#83/#84): after a quality switch the
  // player must resume at the captured position; a *later* switch made from a
  // different position must resume at that newer position, not the stale one.
  await page.goto('/')
  const firstCard = page.locator('[data-testid="movie-card"]').first()
  await expect(firstCard).toBeVisible({ timeout: 15_000 })
  await firstCard.click()

  await expect(page).toHaveURL(/\/play\//, { timeout: 10_000 })
  await expect(page.getByText('Starting playback…')).not.toBeVisible({ timeout: 60_000 })

  const video = page.locator('video')
  await expect(video).toBeVisible({ timeout: 10_000 })

  // Wait until playback has advanced past ~8s so we have a non-trivial position.
  await expect(async () => {
    const t = await video.evaluate((el: HTMLVideoElement) => el.currentTime)
    expect(t).toBeGreaterThan(8)
  }).toPass({ timeout: 40_000, intervals: [1_000] })

  // Helper: pick a quality option from the TrackSelector that differs from the
  // current selection. The selector markup may vary, so target the quality
  // <select> / option list by accessible name and choose a different value.
  const qualitySelect = page.getByLabel(/quality/i)
  await expect(qualitySelect).toBeVisible({ timeout: 10_000 })

  // First switch — capture position, change quality, expect resume near it.
  const pos1 = await video.evaluate((el: HTMLVideoElement) => el.currentTime)
  await qualitySelect.selectOption({ index: 1 })
  await expect(async () => {
    const t = await video.evaluate((el: HTMLVideoElement) => el.currentTime)
    // Resume should land within ~5s of where we switched (segment alignment +
    // network jitter), and must NOT have reset to 0.
    expect(Math.abs(t - pos1)).toBeLessThan(5)
  }).toPass({ timeout: 30_000, intervals: [1_000] })

  // Seek forward, then switch again. The second switch must resume near the
  // NEW position — proving resumeAtSec was cleared after the first switch.
  await video.evaluate((el: HTMLVideoElement) => { el.currentTime = el.currentTime + 20 })
  await expect(async () => {
    const t = await video.evaluate((el: HTMLVideoElement) => el.currentTime)
    expect(t).toBeGreaterThan(pos1 + 15)
  }).toPass({ timeout: 15_000, intervals: [500] })
  const pos2 = await video.evaluate((el: HTMLVideoElement) => el.currentTime)

  await qualitySelect.selectOption({ index: 2 })
  await expect(async () => {
    const t = await video.evaluate((el: HTMLVideoElement) => el.currentTime)
    expect(Math.abs(t - pos2)).toBeLessThan(8) // near pos2, not stale pos1
    expect(t).toBeGreaterThan(pos1 + 10)        // definitively past the stale value
  }).toPass({ timeout: 30_000, intervals: [1_000] })
})

test('back button disconnects session and returns to library', async ({ page }) => {
  await page.goto('/')
  const firstCard = page.locator('[data-testid="movie-card"]').first()
  await expect(firstCard).toBeVisible({ timeout: 15_000 })
  await firstCard.click()

  await expect(page).toHaveURL(/\/play\//)
  // Wait for player page to at least reach the loading phase
  await expect(page.getByText('Starting playback…')).toBeVisible({ timeout: 15_000 })

  // Click back — should return to library without errors
  const backBtn = page.getByText('← Library')
  await expect(backBtn).toBeVisible()
  await backBtn.click()

  await expect(page).toHaveURL('/', { timeout: 10_000 })
})
