/**
 * Dev-only seed endpoint. Wired into the server only when
 * HORIZON_DEV_SEED=1 — production builds never expose this.
 *
 *   POST /dev/seed/:scenario   → applies the named mock scenario
 *   GET  /dev/seed             → lists available scenarios
 *
 * Used by Playwright e2e specs to deterministically set library state before
 * each test, and by humans poking at the UI during development.
 */
import type { FastifyInstance } from 'fastify'
import type { MediaRepo } from '../repos/media.ts'
import type { CollectionsRepo } from '../repos/collections.ts'
import type { DatabaseSync } from '../db/index.ts'
import { applyScenario, isScenarioName, SCENARIO_NAMES } from '../seed/scenarios.ts'
import { badRequest, ErrorCodes } from './errors.ts'

export interface DevDeps {
  media: MediaRepo
  collections: CollectionsRepo
  db: DatabaseSync
}

export function registerDev(app: FastifyInstance, deps: DevDeps): void {
  app.get('/dev/seed', async () => ({ scenarios: SCENARIO_NAMES }))

  app.post<{ Params: { scenario: string } }>(
    '/dev/seed/:scenario',
    async (req, reply) => {
      const name = req.params.scenario
      if (!isScenarioName(name)) {
        return badRequest(reply, ErrorCodes.UNKNOWN_SCENARIO,
          `Unknown scenario "${name}". Valid: ${SCENARIO_NAMES.join(', ')}`)
      }
      const result = applyScenario(name, {
        media: deps.media,
        collections: deps.collections,
        rawDb: deps.db,
      })
      return result
    },
  )
}
