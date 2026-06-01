import type { FastifyInstance } from 'fastify'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.ts'
import type { MediaRepo } from '../repos/media.ts'
import type { CollectionsRepo } from '../repos/collections.ts'
import type { UserRepo } from '../repos/users.ts'
import type { ScanWorkers } from '../server.ts'
import { sendNotFound, badRequest, overCapacity, errorReply, ErrorCodes } from './errors.ts'
import { resolveCallerRole } from './authz.ts'
import { resolveUnderBases } from '../paths/confine.ts'

export function registerLibrary(
  app: FastifyInstance,
  media: MediaRepo,
  collections: CollectionsRepo,
  workers: ScanWorkers,
  users: UserRepo,
  cfg: Config,
) {
  /**
   * Confined directory browser for picking library roots in the UI. Owner/admin
   * only — members must not be able to enumerate the server filesystem.
   *
   *  - No (or empty) `path` → the configured bases (cfg.mediaBases) as the
   *    top-level entries; `parent` is null (you can't go above the bases).
   *  - With `path` → resolveUnderBases gates it (null → 400 INVALID_PATH), then
   *    we list IMMEDIATE SUBDIRECTORIES only (never files). `parent` is the
   *    path's parent iff it still resolves under a base, else null.
   */
  app.get<{ Querystring: { path?: string } }>('/library/browse', async (req, reply) => {
    const caller = resolveCallerRole(users, req)
    if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Missing or unknown X-Horizon-User header')
    if (caller.role === 'member') {
      return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Only owner or admin can browse the filesystem')
    }

    const raw = req.query.path
    if (!raw) {
      // Top level: the operator-mounted bases. No parent — can't browse above.
      return {
        entries: cfg.mediaBases.map(b => ({ name: path.basename(b) || b, path: b })),
        parent: null,
      }
    }

    const resolved = resolveUnderBases(cfg.mediaBases, raw)
    if (resolved === null) {
      return badRequest(reply, ErrorCodes.INVALID_PATH, 'Path is outside the configured media bases')
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

    // Offer a parent only while it still resolves under a base — never above.
    const parentCandidate = path.dirname(resolved)
    const parent = parentCandidate === resolved ? null : resolveUnderBases(cfg.mediaBases, parentCandidate)

    return { entries, parent }
  })


  app.get('/library/movies', async (req, reply) => {
    const caller = resolveCallerRole(users, req)
    if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Missing or unknown X-Horizon-User header')
    return media.listMovies()
  })

  app.get('/library/movies/collections', async (req, reply) => {
    const caller = resolveCallerRole(users, req)
    if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Missing or unknown X-Horizon-User header')
    const cols = collections.list()
    return cols.map(c => ({
      id: c.id,
      name: c.name,
      movies: c.movieIds.map(id => media.getById(id)).filter((m): m is NonNullable<typeof m> => !!m),
    }))
  })

  app.get<{ Params: { collection: string } }>(
    '/library/movies/collections/:collection',
    async (req, reply) => {
      const caller = resolveCallerRole(users, req)
      if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Missing or unknown X-Horizon-User header')
      const col = collections.list().find(c => c.id === req.params.collection)
      if (!col) return sendNotFound(reply, ErrorCodes.NOT_FOUND, 'Collection not found')
      return {
        id: col.id,
        name: col.name,
        movies: col.movieIds.map(id => media.getById(id)).filter((m): m is NonNullable<typeof m> => !!m),
      }
    },
  )

  app.get('/library/shows', async (req, reply) => {
    const caller = resolveCallerRole(users, req)
    if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Missing or unknown X-Horizon-User header')
    const shows = media.listShows()
    return shows.map(s => ({ ...s, seasons: media.getSeasons(s.id) }))
  })

  app.get<{ Params: { show: string } }>(
    '/library/shows/:show',
    async (req, reply) => {
      const caller = resolveCallerRole(users, req)
      if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Missing or unknown X-Horizon-User header')
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
      const caller = resolveCallerRole(users, req)
      if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Missing or unknown X-Horizon-User header')
      const show = media.getById(req.params.show)
      if (!show) return sendNotFound(reply, ErrorCodes.NOT_FOUND, 'Show not found')
      return media.getSeasons(show.id)
    },
  )

  app.get<{ Params: { show: string; season: string } }>(
    '/library/shows/:show/seasons/:season',
    async (req, reply) => {
      const caller = resolveCallerRole(users, req)
      if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Missing or unknown X-Horizon-User header')
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
      const caller = resolveCallerRole(users, req)
      if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Missing or unknown X-Horizon-User header')
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
    const caller = resolveCallerRole(users, req)
    if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Missing or unknown X-Horizon-User header')
    if (caller.role === 'member') {
      return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Only owner or admin can trigger a metadata refresh')
    }
    if (!workers.refreshWorker.status().configured) {
      return overCapacity(reply, ErrorCodes.TMDB_DISABLED, 'TMDB not configured')
    }
    void workers.refreshWorker.run({ useChangesFeed: true })
      .catch(err => app.log.error({ err }, 'Metadata refresh failed'))
    return reply.status(202).send({ status: 'queued' })
  })

  /**
   * Combined scan + metadata health snapshot. Polling target for the UI.
   */
  app.get('/library/scan-status', async (req, reply) => {
    const caller = resolveCallerRole(users, req)
    if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Missing or unknown X-Horizon-User header')
    const scan = workers.scanManager.status()
    const refresh = workers.refreshWorker.status()
    return {
      scan,
      metadata: refresh,
      recentRuns: workers.scanHistory.recent(20),
    }
  })
}
