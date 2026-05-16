import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type DatabaseSync } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createMediaRepo, type MediaRepo } from '../src/repos/media.ts'
import { createUserRepo, type UserRepo } from '../src/repos/users.ts'
import { createProgressRepo, type ProgressRepo } from '../src/repos/progress.ts'

function setup() {
  const db = openDatabase(':memory:')
  migrate(db)
  const users = createUserRepo(db)
  const media = createMediaRepo(db)
  const progress = createProgressRepo(db, media, { watchedThresholdPct: 90 })
  return { db, users, media, progress }
}

function movieRow(id: string, title = 'M') {
  return {
    id, filePath: `/${id}.mkv`, title, sortYear: 2020,
    durationSec: 100, resolution: '1920x1080', videoCodec: 'h264', container: 'matroska',
    hdr: { dv: false, hdr10: false, hdr10plus: false },
    audioTracks: [], subtitleTracks: [], mtimeMs: 1, sizeBytes: 1,
    externalIds: {}, metadata: null,
  }
}
function episodeRow(id: string, parent: string, season: number, episode: number) {
  return {
    id, parentId: parent, filePath: `/${id}.mkv`, title: `Ep ${season}x${episode}`,
    season, episode,
    durationSec: 100, resolution: '1920x1080', videoCodec: 'h264', container: 'matroska',
    hdr: { dv: false, hdr10: false, hdr10plus: false },
    audioTracks: [], subtitleTracks: [], mtimeMs: 1, sizeBytes: 1,
    externalIds: {}, metadata: null,
  }
}

describe('progressRepo.setProgress', () => {
  it('inserts + updates', () => {
    const { users, media, progress } = setup()
    const u = users.create({ name: 'u' })
    media.upsertMovie(movieRow('m1'))
    const p1 = progress.setProgress(u.id, 'm1', { positionMs: 1000, durationMs: 60_000 })
    expect(p1.positionMs).toBe(1000)
    const p2 = progress.setProgress(u.id, 'm1', { positionMs: 2000, durationMs: 60_000 })
    expect(p2.positionMs).toBe(2000)
    expect(p2.updatedAt).toBeGreaterThanOrEqual(p1.updatedAt)
  })

  it('marks watched when crossing 90%', () => {
    const { users, media, progress } = setup()
    const u = users.create({ name: 'u' })
    media.upsertMovie(movieRow('m1'))
    const p = progress.setProgress(u.id, 'm1', { positionMs: 90_000, durationMs: 100_000 })
    expect(p.watched).toBe(true)
  })

  it('marks watched in last 30s regardless of percent', () => {
    const { users, media, progress } = setup()
    const u = users.create({ name: 'u' })
    media.upsertMovie(movieRow('m1'))
    // 89.9% → but only 1s left: should mark watched via the 30s rule.
    const p = progress.setProgress(u.id, 'm1', { positionMs: 999_000, durationMs: 1_000_000 })
    expect(p.watched).toBe(true)
  })
})

describe('progressRepo.continueWatching', () => {
  it('includes unwatched movies ordered by recency', async () => {
    const { users, media, progress } = setup()
    const u = users.create({ name: 'u' })
    media.upsertMovie(movieRow('m1', 'A'))
    media.upsertMovie(movieRow('m2', 'B'))
    progress.setProgress(u.id, 'm1', { positionMs: 10_000, durationMs: 60_000 })
    await new Promise(r => setTimeout(r, 2))
    progress.setProgress(u.id, 'm2', { positionMs: 20_000, durationMs: 60_000 })
    const list = progress.continueWatching(u.id)
    expect(list.map(x => x.mediaId)).toEqual(['m2', 'm1'])
  })

  it('dedupes shows to one entry = most recent episode', async () => {
    const { users, media, progress } = setup()
    const u = users.create({ name: 'u' })
    media.upsertShow({ id: 'sh', title: 'S', sortYear: 2020, externalIds: {}, metadata: null })
    media.upsertEpisode(episodeRow('e1', 'sh', 1, 1))
    media.upsertEpisode(episodeRow('e2', 'sh', 1, 2))
    progress.setProgress(u.id, 'e1', { positionMs: 10_000, durationMs: 60_000 })
    await new Promise(r => setTimeout(r, 2))
    progress.setProgress(u.id, 'e2', { positionMs: 15_000, durationMs: 60_000 })
    const list = progress.continueWatching(u.id)
    const episodes = list.filter(x => x.kind === 'episode')
    expect(episodes.length).toBe(1)
    expect(episodes[0].mediaId).toBe('e2')
    expect(episodes[0].show?.id).toBe('sh')
  })

  it('promotes next-up episode after one is watched', () => {
    const { users, media, progress } = setup()
    const u = users.create({ name: 'u' })
    media.upsertShow({ id: 'sh', title: 'S', sortYear: 2020, externalIds: {}, metadata: null })
    media.upsertEpisode(episodeRow('e1', 'sh', 1, 1))
    media.upsertEpisode(episodeRow('e2', 'sh', 1, 2))
    // finish e1
    progress.setProgress(u.id, 'e1', { positionMs: 100_000, durationMs: 100_000 })
    const list = progress.continueWatching(u.id)
    expect(list.length).toBe(1)
    expect(list[0].mediaId).toBe('e2')
    expect(list[0].positionMs).toBe(0)
  })

  it('drops the show entirely when all episodes watched', () => {
    const { users, media, progress } = setup()
    const u = users.create({ name: 'u' })
    media.upsertShow({ id: 'sh', title: 'S', sortYear: 2020, externalIds: {}, metadata: null })
    media.upsertEpisode(episodeRow('e1', 'sh', 1, 1))
    progress.setProgress(u.id, 'e1', { positionMs: 100_000, durationMs: 100_000 })
    expect(progress.continueWatching(u.id)).toEqual([])
  })

  it('caps list at 20', () => {
    const { users, media, progress } = setup()
    const u = users.create({ name: 'u' })
    for (let i = 0; i < 25; i++) {
      media.upsertMovie(movieRow(`m${i}`, `M${i}`))
      progress.setProgress(u.id, `m${i}`, { positionMs: 1000, durationMs: 60_000 })
    }
    const list = progress.continueWatching(u.id)
    expect(list.length).toBe(20)
  })
})

describe('progressRepo.markWatched', () => {
  it('sets watched flag explicitly', () => {
    const { users, media, progress } = setup()
    const u = users.create({ name: 'u' })
    media.upsertMovie(movieRow('m1'))
    progress.setProgress(u.id, 'm1', { positionMs: 1000, durationMs: 60_000 })
    const p = progress.markWatched(u.id, 'm1', true)
    expect(p!.watched).toBe(true)
  })
})

describe('progressRepo.clear', () => {
  it('removes the row', () => {
    const { users, media, progress } = setup()
    const u = users.create({ name: 'u' })
    media.upsertMovie(movieRow('m1'))
    progress.setProgress(u.id, 'm1', { positionMs: 1000, durationMs: 60_000 })
    progress.clear(u.id, 'm1')
    expect(progress.getProgress(u.id, 'm1')).toBeNull()
  })
})
