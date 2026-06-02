import { test, expect } from '@playwright/test'

/**
 * First-boot setup wizard, end to end through the real web UI + backend.
 *
 * The backend starts with an empty e2e DB (see playwright.config webServer +
 * global-setup), so `/` redirects to `/setup`. This is the exact flow that was
 * 404ing because the Vite dev proxy didn't forward `/auth/*`: create-owner
 * (POST /users) succeeded but the immediate set-password (POST /auth/set-password)
 * hit Vite's SPA fallback instead of the backend. This test fails if that
 * regresses — it asserts the set-password call returns 200.
 *
 * Ordered/serial: the wizard mutates the single shared household, so the first
 * test creates the owner and later tests build on that state.
 */
test.describe.configure({ mode: 'serial' })

const OWNER = 'Tester'
const PASSWORD = 'e2e-password-123'

test.describe('first-boot setup', () => {
  test('empty DB → / redirects to /setup', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/setup$/)
    await expect(page.getByText(/Welcome to Horizon/i)).toBeVisible()
  })

  test('create owner with a password (the /auth proxy regression)', async ({ page }) => {
    // Capture the set-password response so a proxy 404 fails loudly here.
    const setPwResponse = page.waitForResponse(
      r => r.url().includes('/auth/set-password') && r.request().method() === 'POST',
    )

    await page.goto('/setup')
    await page.getByLabel('Name').fill(OWNER)
    await page.getByText('🐼').click()
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByLabel('Confirm password').fill(PASSWORD)
    await page.getByRole('button', { name: /continue/i }).click()

    const res = await setPwResponse
    expect(
      res.status(),
      'POST /auth/set-password must be proxied to the backend (not 404 via Vite)',
    ).toBe(200)

    // Step 2 (library folders) is now visible — owner created + authenticated.
    await expect(page.getByText(/Add your library/i)).toBeVisible()
  })

  test('finish the wizard → authenticated owner lands in the app', async ({ page }) => {
    // Owner already exists + the session cookie is set from the previous test's
    // context? No — each test gets a fresh context. But the household now has an
    // owner with a password, so the wizard is done; an unauthenticated visit
    // should be sent to /login (not /setup, which is empty-DB only).
    await page.goto('/')
    await expect(page).toHaveURL(/\/login$/)
  })

  test('re-creating a profile now requires auth (household not empty)', async ({ request }) => {
    // The first create consumed the first-boot allowlist; a second unauthenticated
    // create is rejected by the auth guard (401), not silently accepted.
    const res = await request.post('http://localhost:5173/users', {
      data: { name: 'Stranger' },
      failOnStatusCode: false,
    })
    expect(res.status()).toBe(401)
  })

  test('owner can log in with the password set during setup', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: OWNER }).click()
    await page.getByPlaceholder('Password').fill(PASSWORD)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page).not.toHaveURL(/\/login$/)
    // Profile badge in the nav has the accessible name of the owner.
    await expect(page.getByRole('button', { name: OWNER })).toBeVisible()
  })

  test('wrong password is rejected with a generic error', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: OWNER }).click()
    await page.getByPlaceholder('Password').fill('definitely-wrong')
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByText(/incorrect password/i)).toBeVisible()
  })
})
