/**
 * E2E playback test.
 *
 * Preconditions:
 *   • Horizon server running on :7777  (`npm run dev:server`)
 *   • At least one video file in the library directory
 *
 * Playwright starts Vite on :5173 automatically (see playwright.config.ts).
 */

import { test, expect, type Page, type ConsoleMessage } from '@playwright/test'

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
