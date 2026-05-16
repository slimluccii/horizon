import { test, expect } from '@playwright/test'

test('first-run: / redirects to /setup, creating profile lands on library', async ({ page, request }) => {
  // Clean slate: delete any existing users via API
  const list = await request.get('http://localhost:5173/users')
  const users = (await list.json()) as { id: string }[]
  for (const u of users) await request.delete(`http://localhost:5173/users/${u.id}`)

  await page.goto('http://localhost:5173/')
  await expect(page).toHaveURL(/\/setup$/)

  await page.getByLabel('Name').fill('Testy')
  await page.getByText('🐼').click()
  await page.getByRole('button', { name: /get started/i }).click()

  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByText('Horizon')).toBeVisible()
  await expect(page.getByText('Testy')).toBeVisible() // profile badge
})
