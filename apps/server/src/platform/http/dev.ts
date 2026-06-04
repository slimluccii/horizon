/**
 * Dev-only seed endpoint. Wired into the server only when
 * HORIZON_DEV_SEED=1 — production builds never expose this.
 *
 *   POST /dev/seed/:scenario   → applies the named mock scenario
 *   GET  /dev/seed             → lists available scenarios
 *
 * Used by Playwright e2e specs to deterministically set library state before
 * each test, and by humans poking at the UI during development.
 *
 * POST /dev/seed/:scenario is destructive (it wipes + reseeds the DB) and is
 * rate-limited to 1 call per 5 minutes per IP to blunt rapid-fire abuse even
 * where HORIZON_DEV_SEED=1 is intentionally enabled. GET /dev/seed is not
 * limited. The accompanying startup guard (index.ts) refuses to boot when the
 * flag is set with NODE_ENV=production, so these routes can never reach prod.
 */
import type { FastifyInstance } from 'fastify'
import type { MediaRepo, CollectionsRepo } from '../../contexts/library/index.ts'
import type { DatabaseSync } from '../db/connection.ts'
import { applyScenario, isScenarioName, SCENARIO_NAMES } from '../seed/scenarios.ts'
import { badRequest, ErrorCodes } from './errors.ts'
import { IpRateLimiter, rateLimit } from './rateLimit.ts'

const SEED_WINDOW_MS = 5 * 60 * 1000
// Strict by default (blunt abuse if a DEV_SEED deployment leaks). E2E runs many
// seeds per run, so the cap is overridable via HORIZON_DEV_SEED_MAX_PER_WINDOW.
// Only meaningful when HORIZON_DEV_SEED=1 anyway (the routes don't exist otherwise).
const SEED_MAX_PER_WINDOW = (() => {
  const raw = process.env.HORIZON_DEV_SEED_MAX_PER_WINDOW
  const n = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : 1
})()

export interface DevDeps {
  media: MediaRepo
  collections: CollectionsRepo
  db: DatabaseSync
}

export function registerDev(app: FastifyInstance, deps: DevDeps): void {
  app.get('/dev/seed', async () => ({ scenarios: SCENARIO_NAMES }))

  const seedLimiter = new IpRateLimiter(SEED_WINDOW_MS)

  app.post<{ Params: { scenario: string } }>(
    '/dev/seed/:scenario',
    { preHandler: rateLimit(seedLimiter, SEED_MAX_PER_WINDOW) }, // 1 req / 5 min / IP
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
