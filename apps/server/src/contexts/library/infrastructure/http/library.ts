import type { FastifyInstance } from 'fastify'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import type { Config } from '../../../../platform/config/config.ts'
import type { MediaRepo } from '../persistence/media.ts'
import type { CollectionsRepo } from '../persistence/collections.ts'
import type { UserRepo } from '../../../identity/index.ts'
import type { ScanWorkers } from '../../../../platform/http/server.ts'
import { sendNotFound, badRequest, overCapacity, errorReply, ErrorCodes } from '../../../../platform/http/errors.ts'
import { resolveCallerRole } from '../../../identity/index.ts'
import { streamActivity, sseFrame } from '../../../activity/index.ts'

// Re-exported so existing importers (tests) keep working after the move.
export { sseFrame }

export function registerLibrary(
  app: FastifyInstance,
  media: MediaRepo,
  collections: CollectionsRepo,
  workers: ScanWorkers,
  users: UserRepo,
  cfg: Config,
) {
  /**
   * Filesystem directory browser for picking library roots in the UI. Owner/admin
   * only — members must not be able to enumerate the server filesystem.
   *
   * There is no path confinement: an authenticated owner/admin may browse
   * anywhere the server process can read (the Plex/Jellyfin model). In Docker the
   * container only sees its mounted volumes, so this is naturally scoped to what
   * was mounted; on bare metal it is the whole host filesystem.
   *
   *  - No (or empty) `path` → the filesystem root (`/`); `parent` is null.
   *  - With `path` → must be an absolute, existing, readable directory. We list
   *    IMMEDIATE SUBDIRECTORIES only (never files). `parent` is the path's parent,
   *    or null at the root.
   */
  app.get<{ Querystring: { path?: string } }>('/library/browse', async (req, reply) => {
    const caller = resolveCallerRole(req)
    if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Authentication required')
    if (caller.role === 'member') {
      return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Only owner or admin can browse the filesystem')
    }

    // Default to the filesystem root; resolve to collapse any `.`/`..` segments
    // into a canonical absolute path. Reject anything that isn't absolute.
    const raw = req.query.path && req.query.path.trim() !== '' ? req.query.path : '/'
    const resolved = path.resolve(raw)
    if (!path.isAbsolute(resolved)) {
      return badRequest(reply, ErrorCodes.INVALID_PATH, 'Path must be absolute')
    }

    let dirents: import('node:fs').Dirent[]
    try {
      dirents = readdirSync(resolved, { withFileTypes: true })
    } catch {
      return badRequest(reply, ErrorCodes.INVALID_PATH, 'Path is not a readable directory')
    }

    const entries = dirents
      .filter(d => d.isDirectory())
      .map(d => ({ name: d.name, path: path.join(resolved, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))

    // Parent is null only at the filesystem root (dirname('/') === '/').
    const parentCandidate = path.dirname(resolved)
    const parent = parentCandidate === resolved ? null : parentCandidate

    return { entries, parent }
  })


  app.get('/library/movies', async (req, reply) => {
    const caller = resolveCallerRole(req)
    if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Authentication required')
    return media.listMovies()
  })

  app.get('/library/movies/collections', async (req, reply) => {
    const caller = resolveCallerRole(req)
    if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Authentication required')
    const cols = collections.list()
    return cols.map(c => ({
      id: c.id,
      name: c.name,
      tmdbId: c.tmdbId,
      posterPath: c.posterPath,
      backdropPath: c.backdropPath,
      movies: c.movieIds.map(id => media.getById(id)).filter((m): m is NonNullable<typeof m> => !!m),
    }))
  })

  app.get<{ Params: { collection: string } }>(
    '/library/movies/collections/:collection',
    async (req, reply) => {
      const caller = resolveCallerRole(req)
      if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Authentication required')
      const col = collections.list().find(c => c.id === req.params.collection)
      if (!col) return sendNotFound(reply, ErrorCodes.NOT_FOUND, 'Collection not found')
      return {
        id: col.id,
        name: col.name,
        tmdbId: col.tmdbId,
        posterPath: col.posterPath,
        backdropPath: col.backdropPath,
        movies: col.movieIds.map(id => media.getById(id)).filter((m): m is NonNullable<typeof m> => !!m),
      }
    },
  )

  app.get('/library/shows', async (req, reply) => {
    const caller = resolveCallerRole(req)
    if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Authentication required')
    const shows = media.listShows()
    return shows.map(s => ({ ...s, seasons: media.getSeasons(s.id) }))
  })

  app.get<{ Params: { show: string } }>(
    '/library/shows/:show',
    async (req, reply) => {
      const caller = resolveCallerRole(req)
      if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Authentication required')
      const show = media.getById(req.params.show)
      if (!show || show.kind !== 'show') {
        return sendNotFound(reply, ErrorCodes.NOT_FOUND, 'Show not found')
      }
      return { ...show, seasons: media.getSeasons(show.id) }
    },
  )

  app.get<{ Params: { show: string } }>(
    '/library/shows/:show/seasons',
    async (req, reply) => {
      const caller = resolveCallerRole(req)
      if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Authentication required')
      const show = media.getById(req.params.show)
      if (!show) return sendNotFound(reply, ErrorCodes.NOT_FOUND, 'Show not found')
      return media.getSeasons(show.id)
    },
  )

  app.get<{ Params: { show: string; season: string } }>(
    '/library/shows/:show/seasons/:season',
    async (req, reply) => {
      const caller = resolveCallerRole(req)
      if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Authentication required')
      const show = media.getById(req.params.show)
      if (!show) return sendNotFound(reply, ErrorCodes.NOT_FOUND, 'Show not found')
      const season = parseInt(req.params.season, 10)
      if (!Number.isFinite(season)) {
        return badRequest(reply, ErrorCodes.INVALID_INPUT, 'Invalid season')
      }
      return media.getEpisodes(show.id).filter(e => e.season === season)
    },
  )

  /**
   * Trigger a library rescan. Default: full scan. Provide `paths[]` in the body
   * to scan only specific subtrees (must lie under a configured movies/shows root).
   *
   * Responses:
   *  - 202 + scan status (rescan queued / coalesced into running)
   *  - 200 + scan result (rescan completed inline; rare, only when no other request was running)
   */
  app.post<{ Body?: { paths?: string[] } }>(
    '/library/rescan',
    async (req, reply) => {
      const caller = resolveCallerRole(req)
      if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Authentication required')
      if (caller.role === 'member') {
        return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Only owner or admin can trigger a rescan')
      }
      const paths = req.body?.paths ?? []
      // Fire-and-respond so the HTTP request doesn't hang on long scans.
      void workers.scanManager.request({ trigger: 'manual', paths })
        .catch(err => req.log.error({ err }, 'Manual rescan failed'))
      return reply.status(202).send({ status: 'queued', ...workers.scanManager.status() })
    },
  )

  /**
   * Trigger a metadata refresh sweep (independent of file scan).
   * Useful for the UI button "refresh poster art" without re-walking the disk.
   */
  app.post('/library/metadata-refresh', async (req, reply) => {
    const caller = resolveCallerRole(req)
    if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Authentication required')
    if (caller.role === 'member') {
      return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Only owner or admin can trigger a metadata refresh')
    }
    if (!workers.refreshWorker.status().configured) {
      return overCapacity(reply, ErrorCodes.TMDB_DISABLED, 'TMDB not configured')
    }
    // Manual "refresh now" → drain the full queue (changes feed + every stale/
    // never-fetched item), not just one batch.
    void workers.refreshWorker.run({ useChangesFeed: true, drain: true })
      .catch(err => app.log.error({ err }, 'Metadata refresh failed'))
    return reply.status(202).send({ status: 'queued' })
  })

  /**
   * Combined scan + metadata health snapshot. Polling target for the UI.
   */
  app.get('/library/scan-status', async (req, reply) => {
    const caller = resolveCallerRole(req)
    if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Authentication required')
    const scan = workers.scanManager.status()
    const refresh = workers.refreshWorker.status()
    return {
      scan,
      metadata: refresh,
      recentRuns: workers.scanHistory.recent(20),
    }
  })

  /**
   * Server-Sent-Events stream of the live activity feed (owner/admin only).
   * Replays the ring buffer, then streams live events; sends a comment ping
   * every 15s to keep the connection alive through proxies.
   */
  app.get('/library/activity/stream', async (req, reply) => {
    const caller = resolveCallerRole(req)
    if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Authentication required')
    if (caller.role === 'member') {
      return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Only owner or admin can view activity')
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    reply.hijack()

    // Replay the ring buffer, then stream live until the client disconnects.
    streamActivity(workers.activityBus, reply.raw, req.raw)
  })
}
