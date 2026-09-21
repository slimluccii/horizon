import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../../../../platform/db/connection.ts'
import { migrate } from '../../../../platform/db/migrations.ts'
import { createMediaRepo } from './media.ts'

// The Android TV app has its own Kotlin models. This fixture is what the server
// really sends; the Kotlin ModelsContractTest decodes the same file, so a field
// that changes here fails a test on one side or the other.
const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../../android-tv/app/src/test/resources/contract/media-items.json',
)

function wireItems() {
  const db = openDatabase(':memory:')
  migrate(db)
  const media = createMediaRepo(db)
  const tracks = {
    hdr: { dv: false, hdr10: true, hdr10plus: false },
    audioTracks: [{ index: 0, codec: 'eac3', channels: 6, language: 'eng', title: 'Surround', default: true }],
    subtitleTracks: [{ index: 0, codec: 'subrip', language: 'nld', forced: false, embeddable: true }],
  }
  media.upsertMovie({
    id: 'movie1', filePath: '/media/movies/Dune (2021)/Dune (2021).mkv', title: 'Dune', sortYear: 2021,
    durationSec: 9300.5, resolution: '3840x2160', videoCodec: 'hevc', videoBitrate: 58_000_000, container: 'matroska,webm',
    ...tracks, mtimeMs: 1, sizeBytes: 2, externalIds: { tmdb: 438631 },
    metadata: { kind: 'movie', tmdbId: 438631, title: 'Dune', overview: 'Spice.', posterPath: '/dune.jpg' },
  })
  media.upsertShow({ id: 'show1', title: 'Frieren', sortYear: null, externalIds: { tvdb: 424536 }, metadata: null })
  media.upsertEpisode({
    id: 'ep1', parentId: 'show1', filePath: '/media/tv/Frieren/Season 01/Frieren - S01E01-E02.mkv', title: "The Journey's End",
    season: 1, episode: 1, episodeEnd: 2, durationSec: 1500, resolution: '1920x1080', videoCodec: 'h264', container: 'matroska,webm',
    ...tracks, mtimeMs: 1, sizeBytes: 2, externalIds: {}, metadata: null,
  })
  return [media.getById('movie1'), media.getById('show1'), media.getById('ep1')]
}

describe('media item wire contract', () => {
  it('matches the fixture the Android TV models are tested against', () => {
    const actual = `${JSON.stringify(wireItems(), null, 2)}\n`
    if (process.env.UPDATE_CONTRACT === '1' || !existsSync(FIXTURE)) {
      mkdirSync(path.dirname(FIXTURE), { recursive: true })
      writeFileSync(FIXTURE, actual)
    }
    expect(actual).toBe(readFileSync(FIXTURE, 'utf8'))
  })
})
