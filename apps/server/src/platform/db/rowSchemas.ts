import { z } from 'zod'

/**
 * SQLite returns booleans as integers. These helpers convert at the zod
 * boundary so the rest of the app works in native JS types.
 */
const intBool = z.number().int().transform(n => n !== 0)

export const UserRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatar: z.string().nullable(),
  preferences: z.string(),      // JSON blob, left as string at row layer
  role: z.enum(['owner', 'admin', 'member']),
  // Built-in auth (migration v6). Nullable until the user sets a password.
  password_hash: z.string().nullable(),
  password_set_at: z.number().int().nullable(),
  failed_attempts: z.number().int(),
  locked_until: z.number().int().nullable(),
  household_id: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
})
export type UserRow = z.infer<typeof UserRowSchema>

export const MediaKind = z.enum(['movie', 'show', 'episode'])
export type MediaKind = z.infer<typeof MediaKind>

export const MediaItemRowSchema = z.object({
  id: z.string(),
  kind: MediaKind,
  parent_id: z.string().nullable(),

  title: z.string(),
  sort_year: z.number().int().nullable(),
  season: z.number().int().nullable(),
  episode: z.number().int().nullable(),

  file_path: z.string().nullable(),
  duration_sec: z.number().nullable(),
  resolution: z.string().nullable(),
  video_codec: z.string().nullable(),
  container: z.string().nullable(),
  hdr: z.string().nullable(),
  audio_tracks: z.string().nullable(),
  subtitle_tracks: z.string().nullable(),
  mtime_ms: z.number().int().nullable(),
  size_bytes: z.number().int().nullable(),

  external_ids: z.string(),
  metadata: z.string().nullable(),

  first_seen_at: z.number().int(),
  last_seen_at: z.number().int(),
  deleted_at: z.number().int().nullable(),
})
export type MediaItemRow = z.infer<typeof MediaItemRowSchema>

export const WatchProgressRowSchema = z.object({
  user_id: z.string(),
  media_id: z.string(),
  position_ms: z.number().int(),
  duration_ms: z.number().int(),
  watched: intBool,
  updated_at: z.number().int(),
})
export type WatchProgressRow = z.infer<typeof WatchProgressRowSchema>

export const CollectionRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  updated_at: z.number().int(),
})
export type CollectionRow = z.infer<typeof CollectionRowSchema>

export const HouseholdRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner_user_id: z.string().nullable(),
  created_at: z.number(),
})
export type HouseholdRow = z.infer<typeof HouseholdRowSchema>

export const InviteRowSchema = z.object({
  code: z.string(),
  kind: z.enum(['join', 'new_household']),
  household_id: z.string().nullable(),
  created_by: z.string(),
  created_at: z.number(),
  expires_at: z.number(),
  consumed_at: z.number().nullable(),
})
export type InviteRow = z.infer<typeof InviteRowSchema>
