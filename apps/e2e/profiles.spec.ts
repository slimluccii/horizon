import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:5173'

test('switch between two profiles', async ({ page, request }) => {
  // Seed two users
  const a = await request.post(`${BASE}/users`, { data: { name: 'Alice', avatar: '🐱' } })
  const b = await request.post(`${BASE}/users`, { data: { name: 'Bob', avatar: '🐶' } })
  expect(a.ok() && b.ok()).toBe(true)

  await page.goto(`${BASE}/profiles`)
  await page.getByText('Alice').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByText('Alice')).toBeVisible()

  await page.getByText('Alice').click()        // open badge
  await page.getByText('Switch profile').click()
  await page.getByText('Bob').click()
  await expect(page.getByText('Bob')).toBeVisible()
})

test('Profiles tab visible only to owner/admin', async ({ page, request }) => {
  const ownerRes = await request.post(`${BASE}/users`, { data: { name: 'Alice' } })
  const alice = await ownerRes.json()
  const bobRes = await request.post(`${BASE}/users`, { data: { name: 'Bob' } })
  const bob = await bobRes.json()

  // Alice (owner) should see the Profiles tab
  await page.goto(`${BASE}/profiles`)
  await page.getByText('Alice').click()
  await page.goto(`${BASE}/settings`)
  await expect(page.getByRole('button', { name: 'Profiles' })).toBeVisible()

  // Bob (member) should not see the Profiles tab
  await page.getByText('Alice').click() // open badge
  await page.getByText('Switch profile').click()
  await page.getByText('Bob').click()
  await page.goto(`${BASE}/settings`)
  await expect(page.getByRole('button', { name: 'Profiles' })).not.toBeVisible()
})

test('admin can demote another admin', async ({ page, request }) => {
  const ownerRes = await request.post(`${BASE}/users`, { data: { name: 'Alice' } })
  const owner = await ownerRes.json()
  const admin1Res = await request.post(`${BASE}/users`, { data: { name: 'Admin1' } })
  const admin1 = await admin1Res.json()
  const admin2Res = await request.post(`${BASE}/users`, { data: { name: 'Admin2' } })
  const admin2 = await admin2Res.json()

  // Promote admin1 and admin2 via API
  await request.patch(`${BASE}/users/${admin1.id}`, {
    data: { role: 'admin' },
    headers: { 'x-horizon-user': owner.id },
  })
  await request.patch(`${BASE}/users/${admin2.id}`, {
    data: { role: 'admin' },
    headers: { 'x-horizon-user': owner.id },
  })

  // Switch to admin1, open Settings > Profiles, demote admin2
  await page.goto(`${BASE}/profiles`)
  await page.getByText('Admin1').click()
  await page.goto(`${BASE}/settings`)
  await page.getByRole('button', { name: 'Profiles' }).click()

  const admin2Row = page.locator('.settings__profile-row', { hasText: 'Admin2' })
  await admin2Row.locator('select').selectOption('member')

  await expect(admin2Row.locator('select')).toHaveValue('member')
})
