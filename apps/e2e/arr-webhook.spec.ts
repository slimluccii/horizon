/**
 * Sonarr/Radarr webhook against the real server: key handshake, the folder as
 * the arr container sees it mapped onto the library root, and the resulting
 * subtree scan recorded under the `webhook` trigger.
 */
import { test, expect } from '@playwright/test'
import path from 'node:path'
import { realpathSync } from 'node:fs'
import { API, ensureOwner, bearer, scanMoviesRoot, type SessionUser } from './helpers/auth.ts'
import { hasPlayableFixture, E2E_MOVIES } from './global-setup.ts'

test.describe('arr webhook', () => {
  let owner: SessionUser

  test.beforeAll(async ({ request }) => {
    test.skip(!hasPlayableFixture(), 'No fixture movie (ffmpeg unavailable at setup)')
    owner = await ensureOwner(request)
    await scanMoviesRoot(request, owner, E2E_MOVIES)
  })

  test.afterAll(async ({ request }) => {
    if (!hasPlayableFixture()) return
    const o = await ensureOwner(request)
    await request.patch(`${API}/settings/server`, { headers: bearer(o), data: { moviesRoots: [], showsRoots: [] } })
  })

  const radarrDownload = { eventType: 'Download', movie: { folderPath: '/data/media/movies/Test Movie (2024)' } }

  test('rejects a call without the key', async ({ request }) => {
    const res = await request.post(`${API}/webhooks/arr`, { data: radarrDownload })
    expect(res.status()).toBe(401)
  })

  test('maps the radarr folder onto the library root and runs a webhook scan', async ({ request }) => {
    const keyRes = await request.post(`${API}/webhooks/arr/key`, { headers: bearer(owner) })
    expect(keyRes.status()).toBe(201)
    const { key } = await keyRes.json() as { key: string }

    const res = await request.post(`${API}/webhooks/arr`, { headers: { 'x-api-key': key }, data: radarrDownload })
    expect(res.status()).toBe(202)
    // The server stores library roots resolved, and the temp dir is a symlink on macOS.
    expect(await res.json()).toEqual({ paths: [path.join(realpathSync(E2E_MOVIES), 'Test Movie (2024)')] })

    await expect.poll(async () => {
      const status = await (await request.get(`${API}/library/scan-status`, { headers: bearer(owner) })).json() as {
        recentRuns: { trigger: string; finishedAt: number | null }[]
      }
      return status.recentRuns.some(r => r.trigger === 'webhook' && r.finishedAt !== null)
    }, { timeout: 30_000 }).toBe(true)

    const movies = await (await request.get(`${API}/library/movies`, { headers: bearer(owner) })).json() as { title: string }[]
    expect(movies.map(m => m.title)).toEqual(['Test Movie'])
  })
})
