import type { FastifyInstance } from 'fastify'
import { statSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { UserRepo } from '../repos/users.ts'
import type { ServerSettings } from '../repos/serverSettings.ts'
import type { Config } from '../config.ts'
import { badRequest, errorReply, ErrorCodes } from './errors.ts'
import { resolveCallerRole } from './authz.ts'

/**
 * Zod schema for the writable subset of ServerSettingsRow.
 */
const PatchBody = z.object({
  // Library
  watchedThresholdPct: z.number().int().min(1).max(100).optional(),
  scanCronHour: z.number().int().min(0).max(23).optional(),
  scanConcurrency: z.number().int().min(1).max(32).optional(),
  watchFs: z.boolean().optional(),
  watchDebounceMs: z.number().int().min(100).max(60_000).optional(),
  // Metadata
  // tmdbToken is a TMDB v4 API read-access token — a JWT (3 base64url segments
  // separated by dots, ~230 chars). Validate the shape to reject accidental
  // plaintext / wrong-service keys. An empty string (clears the token) and
  // null are allowed; any non-empty value must look like a JWT and be ≥48 chars.
  // NOTE: revisit this regex if TMDB ever moves off JWT bearer tokens.
  tmdbToken: z
    .string()
    .nullable()
    .optional()
    .refine(
      (v) =>
        v === null ||
        v === undefined ||
        v === '' ||
        (v.length >= 48 && /^[A-Za-z0-9\-_.]+\.[A-Za-z0-9\-_.]+\.[A-Za-z0-9\-_.]+$/.test(v)),
      { message: 'TMDB token must be in JWT format (3 base64url segments separated by dots, ≥48 chars)' },
    ),
  // Library roots — absolute paths inside the container. Each must be an
  // existing readable directory; validated below (Zod can't see the filesystem).
  moviesRoots: z.array(z.string()).optional(),
  showsRoots: z.array(z.string()).optional(),
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
  cfg: Config,
): void {
  /**
   * GET /settings/server — open to any authenticated user.
   * Sensitive fields are masked: tmdbToken returns "set"/"unset", never the value.
   */
  app.get('/settings/server', async (req, reply) => {
    const caller = resolveCallerRole(req)
    if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Authentication required')

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
   * Validates the partial body, confines any library roots to the media base(s),
   * persists, and emits change events.
   */
  app.patch('/settings/server', async (req, reply) => {
    const caller = resolveCallerRole(req)
    if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Authentication required')
    if (caller.role === 'member') {
      return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Only owner or admin can change server settings')
    }

    const parse = PatchBody.safeParse(req.body)
    if (!parse.success) return badRequest(reply, ErrorCodes.INVALID_INPUT, parse.error.message)

    const patch = { ...parse.data }
    // Normalise empty string → null (clears the token).
    if (patch.tmdbToken === '') patch.tmdbToken = null

    // Validate library roots: each must be an absolute path to an existing,
    // readable directory. There is no base confinement — an owner/admin may
    // point the library at anything the server process can read (Docker scopes
    // this to mounted volumes). Validate EVERY entry before any write so one bad
    // path rejects the whole patch (no partial update). Store the resolved
    // (symlink-canonical) absolute path.
    for (const key of ['moviesRoots', 'showsRoots'] as const) {
      const roots = patch[key]
      if (roots === undefined) continue
      const resolved: string[] = []
      for (const r of roots) {
        let real: string | null = null
        try {
          const abs = path.resolve(r)
          if (statSync(abs).isDirectory()) real = realpathSync(abs)
        } catch { real = null }
        if (!real) {
          return badRequest(reply, ErrorCodes.INVALID_PATH, `Path "${r}" is not an existing directory`)
        }
        resolved.push(real)
      }
      patch[key] = resolved
    }

    const updated = serverSettings.update(patch)
    return {
      ...updated,
      tmdbToken: updated.tmdbToken ? 'set' : 'unset',
      seededFromEnv: undefined,
    }
  })
}
