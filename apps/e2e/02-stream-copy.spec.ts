/**
 * Stream copy against the real server. A copy can only cut segments at source
 * keyframes, so the playlist is built from a keyframe index. The fixture has
 * irregular keyframes and B-frames, the combination that breaks naive seeking.
 */
import { test, expect, type APIRequestContext } from '@playwright/test'
import WebSocket from 'ws'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { API, APP, ensureOwner, bearer, authBrowser, scanMoviesRoot, type SessionUser } from './helpers/auth.ts'
import { hasPlayableFixture } from './global-setup.ts'

const KEYFRAMES = [0, 0.5, 0.75, 3.25, 3.5, 9, 9.25, 15, 22.5, 23, 31]
const DURATION = 40
const ROOT = path.join(os.tmpdir(), 'horizon-e2e-copy')
const MKV_IN_MP4_ONLY_CLIENT = { videoCodecs: ['h264'], audioCodecs: ['aac'], hdr: [] as string[], maxBitrate: 100_000, container: ['mp4'] }

function ready(owner: SessionUser, sessionId: string): Promise<{ token: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:7777/api/sessions/${sessionId}/ws`, { headers: { authorization: `Bearer ${owner.token}` } })
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'session-ready') resolve({ token: msg.reconnectToken, close: () => ws.close() })
    })
    ws.on('error', reject)
  })
}

test.describe('stream copy', () => {
  let owner: SessionUser
  let mediaId: string

  test.beforeAll(async ({ request }) => {
    test.skip(!hasPlayableFixture(), 'ffmpeg unavailable')
    rmSync(ROOT, { recursive: true, force: true })
    const dir = path.join(ROOT, 'Copy Movie (2021)')
    mkdirSync(dir, { recursive: true })
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc=size=640x360:rate=24:duration=${DURATION}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${DURATION}`,
      '-c:v', 'libx264', '-bf', '2', '-g', '9999', '-keyint_min', '1', '-sc_threshold', '0',
      '-force_key_frames', KEYFRAMES.join(','), '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      path.join(dir, 'Copy Movie (2021).mkv')])
    owner = await ensureOwner(request)
    mediaId = (await scanMoviesRoot(request, owner, realpathSync(ROOT)))[0].id
  })

  test.afterAll(async ({ request }) => {
    if (!hasPlayableFixture()) return
    const o = await ensureOwner(request)
    await request.patch(`${API}/settings/server`, { headers: bearer(o), data: { moviesRoots: [], showsRoots: [] } })
    rmSync(ROOT, { recursive: true, force: true })
  })

  async function start(request: APIRequestContext) {
    const res = await request.post(`${API}/sessions`, { headers: bearer(owner), data: { mediaId, capabilities: MKV_IN_MP4_ONLY_CLIENT } })
    expect(res.ok()).toBe(true)
    return res.json() as Promise<{ sessionId: string; method: string }>
  }
  const stop = (request: APIRequestContext, sessionId: string, token: string) =>
    request.delete(`${API}/sessions/${sessionId}`, { headers: { ...bearer(owner), 'x-reconnect-token': token } })

  test('a file is copied once the scan has indexed its keyframes, and the playlist follows them', async ({ request }) => {
    // The index is built in the background after the scan; until then the file is transcoded.
    let session = await start(request)
    for (let i = 0; session.method !== 'direct-stream' && i < 40; i++) {
      const r = await ready(owner, session.sessionId)
      r.close()
      await stop(request, session.sessionId, r.token)
      await new Promise(res => setTimeout(res, 500))
      session = await start(request)
    }
    expect(session.method).toBe('direct-stream')

    const { token, close } = await ready(owner, session.sessionId)
    const q = `?token=${encodeURIComponent(token)}`
    const playlist = await (await request.get(`${API}/sessions/${session.sessionId}/renditions/0.m3u8${q}`, { headers: bearer(owner) })).text()
    const durations = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map(m => Number(m[1]))
    const gaps = KEYFRAMES.map((k, i) => (KEYFRAMES[i + 1] ?? DURATION) - k)
    expect(durations).toHaveLength(KEYFRAMES.length)
    durations.slice(0, -1).forEach((d, i) => expect(d).toBeCloseTo(gaps[i], 2))

    for (let n = 0; n < KEYFRAMES.length; n++) {
      const seg = await request.get(`${API}/sessions/${session.sessionId}/renditions/0/seg${String(n).padStart(5, '0')}.m4s${q}`, { headers: bearer(owner) })
      expect(seg.status(), `segment ${n}`).toBe(200)
    }
    close()
    await stop(request, session.sessionId, token)
  })

  test('a seek into the middle starts exactly on the keyframe of the requested segment', async ({ request }) => {
    const session = await start(request)
    expect(session.method).toBe('direct-stream')
    const { token, close } = await ready(owner, session.sessionId)
    const q = `?token=${encodeURIComponent(token)}`
    const get = (file: string) => request.get(`${API}/sessions/${session.sessionId}/renditions/0/${file}${q}`, { headers: bearer(owner) })

    // Segment 6 starts on the 9.25 s keyframe, a quarter second after the previous one.
    const seg = await get('seg00006.m4s')
    expect(seg.status()).toBe(200)
    const init = await get('init.mp4')
    const probe = path.join(ROOT, 'probe.mp4')
    writeFileSync(probe, Buffer.concat([await init.body(), await seg.body()]))
    const pts = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', probe])
      .toString().trim().split('\n').map(Number).sort((a, b) => a - b)

    // ffmpeg shifts a B-frame stream by its reorder delay (two frames here), identically in every run.
    expect(pts[0]).toBeGreaterThanOrEqual(9.25)
    expect(pts[0]).toBeLessThan(9.25 + 0.2)
    expect(pts.at(-1)! - pts[0]).toBeLessThan(15 - 9.25)
    close()
    await stop(request, session.sessionId, token)
  })

  test('the web player plays a copied file and lands where the viewer seeks', async ({ browser }) => {
    const ctx = await browser.newContext()
    await authBrowser(ctx, owner)
    const page = await ctx.newPage()
    await page.goto(`${APP}/play/${mediaId}`)
    const video = page.locator('video')
    await expect(video).toBeVisible({ timeout: 60_000 })
    await video.evaluate(async (v: HTMLVideoElement) => { v.muted = true; await v.play() })
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 30_000 }).toBeGreaterThan(0.5)
    expect(await video.evaluate((v: HTMLVideoElement) => Math.round(v.duration))).toBe(DURATION)

    await video.evaluate((v: HTMLVideoElement) => { v.currentTime = 20 })
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 30_000 }).toBeGreaterThan(21)
    expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeLessThan(30)
    await ctx.close()
  })
})
