import type { FastifyInstance } from 'fastify'
import type { MediaRepo } from '../repos/media.ts'
import type { CollectionsRepo } from '../repos/collections.ts'

export function registerLibrary(
  app: FastifyInstance,
  media: MediaRepo,
  collections: CollectionsRepo,
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
      if (!show || show.kind !== 'show' || show.deletedAt !== null) {
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

  app.post('/library/rescan', async () => {
    // Background rescan is now triggered by the index.ts boot sequence;
    // this endpoint is a no-op placeholder for future use.
    return { status: 'scanning' }
  })
}
