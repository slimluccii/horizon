import type { FastifyInstance } from 'fastify'
import type { MediaRepo } from '../repos/media.ts'
import type { CollectionsRepo } from '../repos/collections.ts'
import type { ScanWorkers } from '../server.ts'

export function registerLibrary(
  app: FastifyInstance,
  media: MediaRepo,
  collections: CollectionsRepo,
  workers: ScanWorkers,
) {
  app.get('/library/movies', async () => media.listMovies())

  app.get('/library/movies/collections', async () => {
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
      const col = collections.list().find(c => c.id === req.params.collection)
      if (!col) return reply.status(404).send({ error: 'Collection not found', code: 'not-found' })
      return {
        id: col.id,
        name: col.name,
        movies: col.movieIds.map(id => media.getById(id)).filter((m): m is NonNullable<typeof m> => !!m),
      }
    },
  )

  app.get('/library/shows', async () => {
    const shows = media.listShows()
    return shows.map(s => ({ ...s, seasons: media.getSeasons(s.id) }))
  })

  app.get<{ Params: { show: string } }>(
    '/library/shows/:show',
    async (req, reply) => {
      const show = media.getById(req.params.show)
      if (!show || show.kind !== 'show') {
        return reply.status(404).send({ error: 'Show not found', code: 'not-found' })
      }
      return { ...show, seasons: media.getSeasons(show.id) }
    },
  )

  app.get<{ Params: { show: string } }>(
    '/library/shows/:show/seasons',
    async (req, reply) => {
      const show = media.getById(req.params.show)
      if (!show) return reply.status(404).send({ error: 'Show not found', code: 'not-found' })
      return media.getSeasons(show.id)
    },
  )

  app.get<{ Params: { show: string; season: string } }>(
    '/library/shows/:show/seasons/:season',
    async (req, reply) => {
      const show = media.getById(req.params.show)
      if (!show) return reply.status(404).send({ error: 'Show not found', code: 'not-found' })
      const season = parseInt(req.params.season, 10)
      if (!Number.isFinite(season)) {
        return reply.status(400).send({ error: 'Invalid season', code: 'invalid-input' })
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
  app.post('/library/metadata-refresh', async (_req, reply) => {
    if (!workers.refreshWorker.status().configured) {
      return reply.status(503).send({
        error: 'TMDB not configured', code: 'tmdb-disabled',
      })
    }
    void workers.refreshWorker.run({ useChangesFeed: true })
      .catch(err => app.log.error({ err }, 'Metadata refresh failed'))
    return reply.status(202).send({ status: 'queued' })
  })

  /**
   * Combined scan + metadata health snapshot. Polling target for the UI.
   */
  app.get('/library/scan-status', async () => {
    const scan = workers.scanManager.status()
    const refresh = workers.refreshWorker.status()
    return {
      scan,
      metadata: refresh,
      recentRuns: workers.scanHistory.recent(20),
    }
  })
}
