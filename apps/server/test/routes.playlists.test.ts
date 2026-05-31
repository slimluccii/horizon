import { describe, it, expect, afterEach } from 'vitest'
import Fastify from 'fastify'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createServerSettings } from '../src/repos/serverSettings.ts'
import { createSessionManager } from '../src/session/manager.ts'
import { registerPlaylists } from '../src/routes/playlists.ts'
import type { Session } from '../src/session/types.ts'
import type { PlaybackPlan } from '../src/transcode/plan.ts'

function plan(renditionCount: number): PlaybackPlan {
  return {
    method: renditionCount === 0 ? 'direct-play' : 'transcode',
    renditions: Array.from({ length: renditionCount }, (_, i) => ({
      profile: { name: `r${i}` },
    })),
  } as unknown as PlaybackPlan
}

function makeSession(renditionCount: number) {
  const db = openDatabase(':memory:')
  migrate(db)
  const serverSettings = createServerSettings(db)
  const sessions = createSessionManager(serverSettings)
  const session = sessions.create({
    mediaId: 'm1',
    filePath: '/tmp/x.mkv',
    plan: plan(renditionCount),
    selectedSubtitleTrack: null,
    audioTrackCount: 1,
    subtitleTrackCount: 0,
    renditionCodecs: [],
    sessionDir: '/tmp/sess',
    sessionReady: true,
    durationSec: 100,
  } as unknown as Parameters<typeof sessions.create>[0])
  return { sessions, session }
}

async function buildApp(sessions: ReturnType<typeof createSessionManager>) {
  const app = Fastify({ logger: false })
  registerPlaylists(app, sessions)
  await app.ready()
  return app
}

let app: Awaited<ReturnType<typeof buildApp>> | undefined
afterEach(async () => { if (app) { await app.close(); app = undefined } })

const tokenHeader = (token: string) => ({ 'x-reconnect-token': token })

describe('GET /sessions/:id/renditions/:r.m3u8 rendition bounds', () => {
  it('rejects r >= plan.renditions.length with 400 invalid-input', async () => {
    const { sessions, session } = makeSession(2)
    app = await buildApp(sessions)
    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/renditions/2.m3u8`,
      headers: tokenHeader(session.reconnectToken),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('rejects all renditions for a direct-play session (0 renditions)', async () => {
    const { sessions, session } = makeSession(0)
    app = await buildApp(sessions)
    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/renditions/0.m3u8`,
      headers: tokenHeader(session.reconnectToken),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('accepts a valid r and returns an .m3u8 playlist', async () => {
    const { sessions, session } = makeSession(2)
    app = await buildApp(sessions)
    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/renditions/1.m3u8`,
      headers: tokenHeader(session.reconnectToken),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('mpegurl')
  })
})

describe('playlist routes reconnect token (#41)', () => {
  it('rejects GET stream.m3u8 without the reconnect token with 400 invalid-reconnect-token', async () => {
    const { sessions, session } = makeSession(2)
    app = await buildApp(sessions)
    const res = await app.inject({ method: 'GET', url: `/sessions/${session.id}/stream.m3u8` })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-reconnect-token')
  })

  it('rejects GET renditions/:r.m3u8 without the reconnect token with 400 invalid-reconnect-token', async () => {
    const { sessions, session } = makeSession(2)
    app = await buildApp(sessions)
    const res = await app.inject({ method: 'GET', url: `/sessions/${session.id}/renditions/1.m3u8` })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-reconnect-token')
  })

  it('serves stream.m3u8 with the correct token', async () => {
    const { sessions, session } = makeSession(2)
    app = await buildApp(sessions)
    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/stream.m3u8`,
      headers: tokenHeader(session.reconnectToken),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('mpegurl')
  })
})
