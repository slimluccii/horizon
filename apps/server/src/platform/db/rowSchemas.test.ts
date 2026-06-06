import { describe, it, expect } from 'vitest'
import { UserRowSchema, MediaItemRowSchema, WatchProgressRowSchema, HouseholdRowSchema, InviteRowSchema } from './rowSchemas.ts'

describe('UserRowSchema', () => {
  it('parses a valid row', () => {
    const row = UserRowSchema.parse({
      id: 'u1', name: 'Luuk', avatar: '🐼', preferences: '{}',
      role: 'member',
      password_hash: null, password_set_at: null, failed_attempts: 0, locked_until: null,
      household_id: null,
      created_at: 1, updated_at: 2,
    })
    expect(row.name).toBe('Luuk')
    expect(row.avatar).toBe('🐼')
  })

  it('accepts null avatar', () => {
    const row = UserRowSchema.parse({
      id: 'u1', name: 'x', avatar: null, preferences: '{}',
      role: 'owner',
      password_hash: null, password_set_at: null, failed_attempts: 0, locked_until: null,
      household_id: null,
      created_at: 1, updated_at: 1,
    })
    expect(row.avatar).toBeNull()
  })

  it('parses the auth columns (set password + lockout state)', () => {
    const row = UserRowSchema.parse({
      id: 'u1', name: 'x', avatar: null, preferences: '{}',
      role: 'owner',
      password_hash: '$argon2id$abc', password_set_at: 123, failed_attempts: 3, locked_until: 999,
      household_id: 'h1',
      created_at: 1, updated_at: 1,
    })
    expect(row.password_hash).toBe('$argon2id$abc')
    expect(row.failed_attempts).toBe(3)
    expect(row.locked_until).toBe(999)
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

describe('HouseholdRowSchema', () => {
  it('parses a valid row', () => {
    const row = HouseholdRowSchema.parse({
      id: 'h1', name: 'Home', owner_user_id: 'u1', created_at: 1,
    })
    expect(row.name).toBe('Home')
    expect(row.owner_user_id).toBe('u1')
  })

  it('accepts a null owner_user_id', () => {
    const row = HouseholdRowSchema.parse({
      id: 'h1', name: 'Home', owner_user_id: null, created_at: 1,
    })
    expect(row.owner_user_id).toBeNull()
  })
})

describe('InviteRowSchema', () => {
  it('parses a valid row', () => {
    const row = InviteRowSchema.parse({
      code: 'abc', kind: 'join', household_id: 'h1', created_by: 'u1',
      created_at: 1, expires_at: 2, consumed_at: null,
    })
    expect(row.kind).toBe('join')
    expect(row.consumed_at).toBeNull()
  })

  it('rejects bad kind', () => {
    expect(() => InviteRowSchema.parse({
      code: 'abc', kind: 'bogus', household_id: 'h1', created_by: 'u1',
      created_at: 1, expires_at: 2, consumed_at: null,
    })).toThrow()
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
