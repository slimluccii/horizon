import { test, expect } from '@playwright/test'

test('switch between two profiles', async ({ page, request }) => {
  // Seed two users
  const a = await request.post('http://localhost:5173/users', { data: { name: 'Alice', avatar: '🐱' } })
  const b = await request.post('http://localhost:5173/users', { data: { name: 'Bob', avatar: '🐶' } })
  expect(a.ok() && b.ok()).toBe(true)

  await page.goto('http://localhost:5173/profiles')
  await page.getByText('Alice').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByText('Alice')).toBeVisible()

  await page.getByText('Alice').click()        // open badge
  await page.getByText('Switch profile').click()
  await page.getByText('Bob').click()
  await expect(page.getByText('Bob')).toBeVisible()
})
