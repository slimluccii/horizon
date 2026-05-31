import { z } from 'zod'

/**
 * Zod schemas for server-to-client WebSocket messages. These mirror the frames
 * the server emits (see apps/server/src/ws/handler.ts) and the `parseWsMessage`
 * discriminator pattern in apps/server/src/ws/messages.ts.
 *
 * The SDK validates every incoming frame with `parseServerMessage` before
 * touching session state. Unknown / malformed frames (e.g. MITM-injected or
 * corrupted) are rejected and silently dropped — fail closed, never mutate
 * `_profile`/`_state` or fire consumer callbacks on bad data. `.strict()`
 * rejects unknown fields. (`QualityProfileSchema` is intentionally NOT strict:
 * the wire `profile` carries display-only extras like `videoCodec`.)
 */

const QualityProfileSchema = z.object({
  name: z.string().optional(),
  videoBitrate: z.number(),
  audioBitrate: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional(),
})

const SessionReadySchema = z.object({
  type: z.literal('session-ready'),
  method: z.string().optional(),
  streamUrl: z.string().optional(),
  profile: QualityProfileSchema,
  reconnectToken: z.string().optional(),
}).strict()

const QualityChangedSchema = z.object({
  type: z.literal('quality-changed'),
  profile: QualityProfileSchema,
  reason: z.string(),
}).strict()

const TrackChangedSchema = z.object({
  type: z.literal('track-changed'),
  audioTrackIndex: z.number().optional(),
  subtitleTrackIndex: z.number().nullable().optional(),
}).strict()

const WarningSchema = z.object({
  type: z.literal('warning'),
  code: z.string(),
  message: z.string(),
}).strict()

const ErrorSchema = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
  fatal: z.boolean().optional(),
}).strict()

const EndedSchema = z.object({
  type: z.literal('ended'),
}).strict()

const SeekReadySchema = z.object({
  type: z.literal('seek-ready'),
  positionMs: z.number(),
}).strict()

export const ServerToClientMessageSchema = z.discriminatedUnion('type', [
  SessionReadySchema,
  QualityChangedSchema,
  TrackChangedSchema,
  WarningSchema,
  ErrorSchema,
  EndedSchema,
  SeekReadySchema,
])

export type ServerToClientMessage = z.infer<typeof ServerToClientMessageSchema>

/**
 * Validate a parsed (post-JSON.parse) frame against the server-to-client union.
 * Returns the typed message on success, or `null` for any invalid input so the
 * caller can fail closed.
 */
export function parseServerMessage(raw: unknown): ServerToClientMessage | null {
  const result = ServerToClientMessageSchema.safeParse(raw)
  return result.success ? result.data : null
}
