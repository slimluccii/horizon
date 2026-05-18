import { describe, it, expect } from 'vitest'
import { UserRowSchema, MediaItemRowSchema, WatchProgressRowSchema } from '../src/db/rowSchemas.ts'

describe('UserRowSchema', () => {
  it('parses a valid row', () => {
    const row = UserRowSchema.parse({
      id: 'u1', name: 'Luuk', avatar: '🐼', preferences: '{}',
      role: 'member', created_at: 1, updated_at: 2,
    })
    expect(row.name).toBe('Luuk')
    expect(row.avatar).toBe('🐼')
  })

  it('accepts null avatar', () => {
    const row = UserRowSchema.parse({
      id: 'u1', name: 'x', avatar: null, preferences: '{}',
      role: 'owner', created_at: 1, updated_at: 1,
    })
    expect(row.avatar).toBeNull()
  })
})

describe('MediaItemRowSchema', () => {
  it('parses a movie row with JSON fields', () => {
    const row = MediaItemRowSchema.parse({
      id: 'm1', kind: 'movie', parent_id: null,
      title: 'Oppenheimer', sort_year: 2023, season: null, episode: null,
      file_path: '/x.mkv', duration_sec: 10000, resolution: '1920x1080',
      video_codec: 'hevc', container: 'mkv',
      hdr: '{"dv":true,"hdr10":true,"hdr10plus":false}',
      audio_tracks: '[]', subtitle_tracks: '[]',
      mtime_ms: 1, size_bytes: 1000,
      external_ids: '{"tmdb":872585}', metadata: null,
      first_seen_at: 1, last_seen_at: 2, deleted_at: null,
    })
    expect(row.kind).toBe('movie')
  })

  it('rejects bad kind', () => {
    expect(() => MediaItemRowSchema.parse({ kind: 'song' })).toThrow()
  })
})

describe('WatchProgressRowSchema', () => {
  it('coerces watched integer to boolean', () => {
    const row = WatchProgressRowSchema.parse({
      user_id: 'u1', media_id: 'm1',
      position_ms: 12_000, duration_ms: 60_000,
      watched: 1, updated_at: 99,
    })
    expect(row.watched).toBe(true)
  })
})
