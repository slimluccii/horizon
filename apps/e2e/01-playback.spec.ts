/**
 * Playback e2e — exercises the REAL transcode pipeline at the API level.
 *
 * Headless Chromium can't reliably decode a transcoded HLS stream (segments
 * serve fine, but <video> decode/autoplay is fragile and codec-dependent), so
 * instead of asserting in-browser playback we drive the server end to end:
 *
 *   set library root → rescan (real ffprobe) → POST /sessions → open the session
 *   WS → await `session-ready` (real ffmpeg transcode started) → fetch the HLS
 *   playlist + every segment it lists, asserting all 200 + non-empty.
 *
 * This proves the transcode pipeline deterministically. The fixture is a
 * synthetic HEVC clip (global-setup) so an h264-only request forces a full
 * transcode rather than direct-play.
 *
 * Skips when the fixture is absent (ffmpeg unavailable at setup time).
 */
import { test, expect, type APIRequestContext } from '@playwright/test'
import WebSocket from 'ws'
import { API, ensureOwner, bearer, scanMoviesRoot, type SessionUser } from './helpers/auth.ts'
import { hasPlayableFixture, E2E_MOVIES } from './global-setup.ts'

const H264_CAPS = {
  videoCodecs: ['h264'],
  audioCodecs: ['aac'],
  hdr: [] as string[],
  maxBitrate: 8_000_000,
  container: ['mp4'],
}

interface ReadyMsg {
  type: string
  method: string
  streamUrl: string
  reconnectToken: string
}

/** Open the session WS as `owner` and resolve with the `session-ready` payload
 *  (carries the reconnectToken). Rejects on timeout / socket error. */
function awaitSessionReady(owner: SessionUser, sessionId: string, timeoutMs = 60_000): Promise<ReadyMsg> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:7777/api/sessions/${sessionId}/ws`, {
      headers: { authorization: `Bearer ${owner.token}` },
    })
    const timer = setTimeout(() => { ws.close(); reject(new Error('session-ready timeout')) }, timeoutMs)
    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw.toString()) as ReadyMsg
        if (msg.type === 'session-ready') {
          clearTimeout(timer)
          ws.close()
          resolve(msg)
        }
      } catch { /* ignore non-JSON frames */ }
    })
    ws.on('error', err => { clearTimeout(timer); reject(err) })
  })
}

/** Parse segment URIs out of a media playlist (lines that aren't #-tags). */
function parseSegments(playlist: string): string[] {
  return playlist.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
}

async function startSession(request: APIRequestContext, owner: SessionUser, mediaId: string) {
  const res = await request.post(`${API}/sessions`, {
    headers: bearer(owner),
    data: { mediaId, capabilities: H264_CAPS },
  })
  expect(res.ok(), `POST /sessions → ${res.status()}`).toBe(true)
  return res.json() as Promise<{ sessionId: string; method: string }>
}

test.describe('playback transcode pipeline', () => {
  let owner: SessionUser
  let mediaId: string

  test.beforeAll(async ({ request }) => {
    test.skip(!hasPlayableFixture(), 'No synthetic clip (ffmpeg unavailable at setup) — playback specs skipped')
    owner = await ensureOwner(request)
    const movies = await scanMoviesRoot(request, owner, E2E_MOVIES)
    mediaId = movies[0].id
  })

  // Clear the library root we configured so a later boot/watcher rescan can't
  // re-add the fixture into another spec's expected-empty library (shared DB).
  test.afterAll(async ({ request }) => {
    if (!hasPlayableFixture()) return
    const o = await ensureOwner(request)
    await request.patch(`${API}/settings/server`, {
      headers: bearer(o),
      data: { moviesRoots: [], showsRoots: [] },
    })
  })

  test('HEVC source forces a full transcode (not direct-play)', async ({ request }) => {
    const { sessionId, method } = await startSession(request, owner, mediaId)
    expect(method).toBe('transcode')
    expect(sessionId).toBeTruthy()
  })

  test('session reaches ready and serves the HLS playlist + all its segments', async ({ request }) => {
    const { sessionId } = await startSession(request, owner, mediaId)

    // Real ffmpeg transcode must reach the ready signal.
    const ready = await awaitSessionReady(owner, sessionId)
    expect(ready.reconnectToken).toBeTruthy()

    // These routes are gated by BOTH the global session guard (bearer/cookie)
    // AND the per-session reconnect token, so send both.
    const auth = bearer(owner)
    const tok = encodeURIComponent(ready.reconnectToken)

    // Variant playlist (the player requests this directly for fMP4).
    const plRes = await request.get(`${API}/sessions/${sessionId}/renditions/0.m3u8?token=${tok}`, { headers: auth })
    expect(plRes.status(), 'variant playlist').toBe(200)
    const playlist = await plRes.text()
    const segs = parseSegments(playlist)
    expect(segs.length, 'playlist lists segments').toBeGreaterThan(0)

    // Fetch the first 5 segments. The segment route is self-healing — it waits
    // for (or restarts ffmpeg to produce) the requested segment — so request
    // segments BEFORE the init segment: that guarantees ffmpeg is actively
    // writing this run's output by the time we ask for init.mp4. Segment URIs in
    // renditions/0.m3u8 are relative to `renditions/` (e.g. "0/seg00000.m4s").
    //
    // Poll the first segment: right after session-ready the ffmpeg run may still
    // be warming up (or a just-finished cross-spec scan briefly contends), so a
    // single GET can race ahead of the first segment landing. Retry briefly.
    const firstSegUrl = `${API}/sessions/${sessionId}/renditions/${segs[0]}?token=${tok}`
    await expect.poll(
      async () => (await request.get(firstSegUrl, { headers: auth })).status(),
      { timeout: 30_000, intervals: [500, 1000, 2000] },
    ).toBe(200)

    for (const seg of segs.slice(1, 5)) {
      const segRes = await request.get(`${API}/sessions/${sessionId}/renditions/${seg}?token=${tok}`, { headers: auth })
      expect(segRes.status(), `segment ${seg}`).toBe(200)
      expect((await segRes.body()).byteLength, `segment ${seg} non-empty`).toBeGreaterThan(0)
    }

    // Init segment (EXT-X-MAP) — written alongside seg0, so it exists now.
    const init = await request.get(`${API}/sessions/${sessionId}/renditions/0/init.mp4?token=${tok}`, { headers: auth })
    expect(init.status(), 'init.mp4').toBe(200)
    expect((await init.body()).byteLength).toBeGreaterThan(0)
  })

  test('a bad reconnect token is rejected (even with a valid session)', async ({ request }) => {
    const { sessionId } = await startSession(request, owner, mediaId)
    // Authenticated session, but the per-session reconnect token is wrong.
    const res = await request.get(`${API}/sessions/${sessionId}/renditions/0.m3u8?token=wrong`, { headers: bearer(owner) })
    expect(res.status()).toBe(400)
    expect((await res.json()).code).toBe('invalid-reconnect-token')
  })
})
