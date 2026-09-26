import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { openDatabase } from '../../../../platform/db/connection.ts'
import { migrate } from '../../../../platform/db/migrations.ts'
import { createUserRepo, createSessionRepo, makeRequireAuth } from '../../../identity/index.ts'
import { createMediaRepo } from '../persistence/media.ts'
import { createMarkersRepo } from '../persistence/markers.ts'
import { registerMarkers } from './markers.ts'

const intro = { kind: 'intro' as const, startMs: 51_000, endMs: 96_000 }

async function setup() {
  const db = openDatabase(':memory:')
  migrate(db)
  const users = createUserRepo(db)
  const member = users.create({ name: 'Carol' })
  const media = createMediaRepo(db)
  const markers = createMarkersRepo(db)
  db.prepare(
    `INSERT INTO media_items (id, kind, title, file_path, mtime_ms, size_bytes, first_seen_at, last_seen_at)
     VALUES ('e1', 'episode', 'Ep', '/tv/e1.mkv', 1000, 5000, 0, 0)`,
  ).run()
  const app = Fastify({ logger: false })
  app.addHook('onRequest', makeRequireAuth(createSessionRepo(db), users))
  registerMarkers(app, media, markers)
  await app.ready()
  const headers = { authorization: `Bearer ${createSessionRepo(db).issue(member.id).token}` }
  return { app, markers, headers }
}

describe('GET /library/media/:id/markers', () => {
  it('returns the markers of the item', async () => {
    const { app, markers, headers } = await setup()
    markers.replace('e1', 'chapter', { mtimeMs: 1000, sizeBytes: 5000, markers: [intro] })
    const res = await app.inject({ method: 'GET', url: '/library/media/e1/markers', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([intro])
  })

  it('returns an empty list for an item without markers', async () => {
    const { app, headers } = await setup()
    const res = await app.inject({ method: 'GET', url: '/library/media/e1/markers', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  it('is not found for an unknown item', async () => {
    const { app, headers } = await setup()
    const res = await app.inject({ method: 'GET', url: '/library/media/nope/markers', headers })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('media-not-found')
  })

  it('requires a session', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'GET', url: '/library/media/e1/markers' })
    expect(res.statusCode).toBe(401)
  })
})
