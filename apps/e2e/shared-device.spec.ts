/**
 * The household head logs in once on a device and chooses who uses it. A shared
 * device shows a Netflix-style picker, including a profile that has no password,
 * and never carries admin rights.
 */
import { test, expect } from '@playwright/test'
import { API, APP, PASSWORD, OWNER_NAME, ensureOwner, bearer } from './helpers/auth.ts'

test.describe('shared device', () => {
  test.beforeAll(async ({ request }) => {
    const owner = await ensureOwner(request)
    const existing = await (await request.get(`${API}/users`, { headers: bearer(owner) })).json() as { name: string }[]
    if (!existing.some(u => u.name === 'Kid')) {
      const res = await request.post(`${API}/users`, { headers: bearer(owner), data: { name: 'Kid' } })
      expect(res.ok()).toBe(true)
    }
  })

  test('nobody is listed before login', async ({ page, request }) => {
    expect((await request.get(`${API}/users`)).status()).toBe(401)
    await page.goto(`${APP}/login`)
    await expect(page.getByLabel('Name')).toBeVisible()
    await expect(page.getByText('Kid')).toHaveCount(0)
  })

  test('the head sets the device up for the household, a kid picks their profile and gets no admin screens', async ({ page }) => {
    await page.goto(`${APP}/login`)
    await page.getByLabel('Name').fill(OWNER_NAME)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: /sign in/i }).click()

    await expect(page.getByRole('heading', { name: 'Who uses this device?' })).toBeVisible()
    await page.getByRole('button', { name: 'My household' }).click()

    await expect(page.getByRole('heading', { name: "Who's watching?" })).toBeVisible()
    await page.getByRole('button', { name: /Kid/ }).click()

    await expect(page).toHaveURL(`${APP}/`)
    await expect(page.getByRole('button', { name: 'Kid', exact: true })).toBeVisible()

    await page.goto(`${APP}/settings`)
    await expect(page.getByRole('button', { name: 'Personal' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Server' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Profiles' })).toHaveCount(0)
  })

  test('a personal device goes straight to the library and keeps its admin screens', async ({ page }) => {
    await page.goto(`${APP}/login`)
    await page.getByLabel('Name').fill(OWNER_NAME)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.getByRole('button', { name: 'Just me' }).click()

    await expect(page).toHaveURL(`${APP}/`)
    await page.goto(`${APP}/settings`)
    await expect(page.getByRole('button', { name: 'Server' })).toBeVisible()
  })
})
