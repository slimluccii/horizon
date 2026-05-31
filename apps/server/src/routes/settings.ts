import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { UserRepo } from '../repos/users.ts'
import type { ServerSettings } from '../repos/serverSettings.ts'
import { badRequest, errorReply, ErrorCodes } from './errors.ts'
import { resolveCallerRole } from './authz.ts'

/**
 * Zod schema for the writable subset of ServerSettingsRow.
 * Only Library knobs for this slice — extend in subsequent slices.
 */
const PatchBody = z.object({
  // Library
  watchedThresholdPct: z.number().int().min(1).max(100).optional(),
  scanCronHour: z.number().int().min(0).max(23).optional(),
  scanConcurrency: z.number().int().min(1).max(32).optional(),
  watchFs: z.boolean().optional(),
  watchDebounceMs: z.number().int().min(100).max(60_000).optional(),
  // Metadata
  tmdbToken: z.string().nullable().optional(),
  metadataBatchSize: z.number().int().min(1).max(500).optional(),
  metadataMaxAgeMovieDays: z.number().int().min(1).optional(),
  metadataMaxAgeShowDays: z.number().int().min(1).optional(),
  metadataMaxAgeEpDays: z.number().int().min(1).optional(),
  // Playback
  maxSessions: z.number().int().min(1).max(64).optional(),
  maxRenditions: z.number().int().min(1).max(8).optional(),
  wsGraceMs: z.number().int().min(0).optional(),
  wsAttachMs: z.number().int().min(0).optional(),
  forceEncoder: z.string().nullable().optional(),
  tonemapOperator: z.string().optional(),
  tonemapParam: z.number().nullable().optional(),
  tonemapDesat: z.number().nullable().optional(),
}).strict()   // reject unknown keys

export function registerSettings(
  app: FastifyInstance,
  users: UserRepo,
  serverSettings: ServerSettings,
): void {
  /**
   * GET /settings/server — open to any authenticated User.
   * Sensitive fields are masked: tmdbToken returns "set"/"unset", never the value.
   */
  app.get('/settings/server', async (req, reply) => {
    const caller = resolveCallerRole(users, req)
    if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Missing or unknown X-Horizon-User header')

    const row = serverSettings.get()
    return {
      ...row,
      // Mask sensitive field
      tmdbToken: row.tmdbToken ? 'set' : 'unset',
      // Strip internal fields
      seededFromEnv: undefined,
    }
  })

  /**
   * PATCH /settings/server — owner + admin only.
   * Accepts a partial body, validates against schema, persists, emits change events.
   */
  app.patch('/settings/server', async (req, reply) => {
    const caller = resolveCallerRole(users, req)
    if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Missing or unknown X-Horizon-User header')
    if (caller.role === 'member') {
      return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Only owner or admin can change server settings')
    }

    const parse = PatchBody.safeParse(req.body)
    if (!parse.success) return badRequest(reply, ErrorCodes.INVALID_INPUT, parse.error.message)

    const patch = { ...parse.data }
    // Normalise empty string → null (clears the token).
    if (patch.tmdbToken === '') patch.tmdbToken = null

    const updated = serverSettings.update(patch)
    return {
      ...updated,
      tmdbToken: updated.tmdbToken ? 'set' : 'unset',
      seededFromEnv: undefined,
    }
  })
}
