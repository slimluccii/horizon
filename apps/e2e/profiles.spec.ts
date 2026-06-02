/**
 * Profiles / role-management e2e over real sessions.
 *
 * Profile *switching* is gone in the auth world (you log out / log in as a
 * different profile rather than hot-swapping a header), so these tests focus on
 * what the Settings → Profiles panel actually does now: the tab is owner/admin
 * only, owner/admin can change another user's role, and a self-demote bounces
 * the viewer back to the Personal tab.
 *
 * Backend on :7777, Vite on :5173 (playwright.config). The browser is
 * authenticated by planting the relevant user's session cookie.
 */
import { test, expect } from '@playwright/test'
import { APP, ensureOwner, createUser, authBrowser } from './helpers/auth.ts'

test.describe('profiles & roles', () => {
  test('owner sees the Profiles tab; members do not', async ({ browser, request }) => {
    const owner = await ensureOwner(request)
    const member = await createUser(request, owner, 'Member-tab')

    // Owner context → Profiles tab visible.
    const ownerCtx = await browser.newContext()
    await authBrowser(ownerCtx, owner)
    const ownerPage = await ownerCtx.newPage()
    await ownerPage.goto(`${APP}/settings`)
    await expect(ownerPage.getByRole('button', { name: 'Profiles' })).toBeVisible()
    await ownerCtx.close()

    // Member context → no Profiles tab (members only get Personal).
    const memberCtx = await browser.newContext()
    await authBrowser(memberCtx, member)
    const memberPage = await memberCtx.newPage()
    await memberPage.goto(`${APP}/settings`)
    await expect(memberPage.getByRole('button', { name: 'Profiles' })).not.toBeVisible()
    await memberCtx.close()
  })

  test('owner can change another user\'s role', async ({ context, page, request }) => {
    const owner = await ensureOwner(request)
    await createUser(request, owner, 'Roley')
    await authBrowser(context, owner)

    await page.goto(`${APP}/settings`)
    await page.getByRole('button', { name: 'Profiles' }).click()

    const row = page.locator('.settings__profile-row', { hasText: 'Roley' })
    await row.locator('select').selectOption('admin')
    await expect(row.locator('select')).toHaveValue('admin')

    // Persisted: re-open Settings and confirm.
    await page.goto(`${APP}/settings`)
    await page.getByRole('button', { name: 'Profiles' }).click()
    await expect(
      page.locator('.settings__profile-row', { hasText: 'Roley' }).locator('select'),
    ).toHaveValue('admin')
  })

  test('admin self-demote → redirected to Personal tab with a toast', async ({ context, page, request }) => {
    const owner = await ensureOwner(request)
    const self = await createUser(request, owner, 'SelfDemote', { role: 'admin' })
    // Act AS the admin: plant their session.
    await authBrowser(context, self)

    await page.goto(`${APP}/settings`)
    await page.getByRole('button', { name: 'Profiles' }).click()

    const selfRow = page.locator('.settings__profile-row', { hasText: 'SelfDemote' })
    await selfRow.locator('select').selectOption('member')

    await expect(page.getByRole('button', { name: 'Personal' })).toHaveClass(/is-active/)
    await expect(page.getByRole('status')).toHaveText(/role changed/i)
  })
})
