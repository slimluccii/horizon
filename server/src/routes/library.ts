import type { FastifyInstance } from 'fastify'
import type { LibraryIndex } from '../scanner/scanner.ts'

export function registerLibrary(app: FastifyInstance, index: LibraryIndex) {
  app.get('/library/movies', async () => index.movies)

  app.get('/library/movies/collections', async () => index.collections)

  app.get<{ Params: { collection: string } }>(
    '/library/movies/collections/:collection',
    async (req, reply) => {
      const col = index.collections.find(c => c.id === req.params.collection)
      if (!col) return reply.status(404).send({ error: 'Collection not found', code: 'not-found' })
      return col
    },
  )

  app.get('/library/shows', async () =>
    [...index.shows.values()].map(s => s.summary)
  )

  app.get<{ Params: { show: string } }>(
    '/library/shows/:show',
    async (req, reply) => {
      const show = index.shows.get(req.params.show)
      if (!show) return reply.status(404).send({ error: 'Show not found', code: 'not-found' })
      return show.summary
    },
  )

  app.get<{ Params: { show: string } }>(
    '/library/shows/:show/seasons',
    async (req, reply) => {
      const show = index.shows.get(req.params.show)
      if (!show) return reply.status(404).send({ error: 'Show not found', code: 'not-found' })
      return show.summary.seasons
    },
  )

  app.get<{ Params: { show: string; season: string } }>(
    '/library/shows/:show/seasons/:season',
    async (req, reply) => {
      const show = index.shows.get(req.params.show)
      if (!show) return reply.status(404).send({ error: 'Show not found', code: 'not-found' })
      const season = parseInt(req.params.season)
      const episodes = show.episodes
        .filter(e => e.season === season)
        .sort((a, b) => a.episode - b.episode)
      return episodes
    },
  )

  app.post('/library/rescan', async () => {
    index.rescan().catch(err => console.error('Rescan error:', err))
    return { status: 'scanning' }
  })
}
