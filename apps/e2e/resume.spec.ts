import { test, expect } from '@playwright/test'

test('resume prompt appears after previous partial play', async ({ page, request }) => {
  const userRes = await request.post('http://localhost:5173/users', { data: { name: 'Resumer' } })
  const user = await userRes.json()
  const movies = await (await request.get('http://localhost:5173/library/movies')).json()
  const movie = movies[0]
  // Seed progress at 30s
  await request.patch(`http://localhost:5173/users/${user.id}/progress/${movie.id}`, {
    headers: { 'x-horizon-user': user.id, 'content-type': 'application/json' },
    data: { watched: false },
  }).catch(() => {/* may 404 if no progress yet */})
  await request.post(`http://localhost:5173/users/${user.id}/progress/${movie.id}`, {
    headers: { 'x-horizon-user': user.id, 'content-type': 'application/json' },
    data: { positionMs: 30_000, durationMs: 3_600_000 },
  }).catch(() => {/* server has no POST — seed via WS instead; see alt path */})

  // Direct SQL-free seed: simulate via PATCH (mark unwatched — already default).
  // Actually we need a progress insert; workaround is to navigate, wait 6s for WS
  // to ingest a progress update, then reload.
  await page.goto('http://localhost:5173/profiles')
  await page.getByText('Resumer').click()
  await page.goto(`http://localhost:5173/play/${movie.id}`)
  await page.waitForTimeout(10_000)   // let WS report progress
  await page.goto(`http://localhost:5173/play/${movie.id}`)
  await expect(page.getByText(/Resume from/i)).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: /resume/i }).click()
  // seeked
})
