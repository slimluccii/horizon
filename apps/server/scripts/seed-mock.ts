/**
 * Seed the local DB with a named mock scenario.
 *
 *   npm -w server run seed:mock                       # default scenario
 *   npm -w server run seed:mock -- --scenario=huge    # 200 movies, 30 shows
 *   npm -w server run seed:mock -- --scenario=empty   # wipe everything
 *
 * Scenarios: empty | tiny | default | huge | mixed-quality | collections-heavy
 *
 * The image proxy renders mock posters via picsum.photos (no TMDB token needed).
 */
import { loadConfig } from '../src/platform/config/config.ts'
import { openDatabase } from '../src/platform/db/connection.ts'
import { migrate } from '../src/platform/db/migrations.ts'
import { createMediaRepo, createCollectionsRepo } from '../src/contexts/library/index.ts'
import { applyScenario, isScenarioName, SCENARIO_NAMES, type ScenarioName } from '../src/platform/seed/scenarios.ts'

function parseScenario(): ScenarioName {
  for (const arg of process.argv.slice(2)) {
    const m = /^--scenario=(.+)$/.exec(arg)
    if (m && isScenarioName(m[1])) return m[1]
    if (m) {
      console.error(`Unknown scenario "${m[1]}". Valid: ${SCENARIO_NAMES.join(', ')}`)
      process.exit(2)
    }
  }
  return 'default'
}

function main() {
  const scenario = parseScenario()
  const cfg = loadConfig()
  const db = openDatabase(cfg.dbPath)
  migrate(db)

  const media = createMediaRepo(db)
  const collections = createCollectionsRepo(db)
  const result = applyScenario(scenario, { media, collections, rawDb: db })

  console.log(`Seeded scenario "${result.scenario}":`)
  console.log(`  movies:      ${result.movies}`)
  console.log(`  shows:       ${result.shows}`)
  console.log(`  episodes:    ${result.episodes}`)
  console.log(`  collections: ${result.collections}`)
  console.log(`DB: ${cfg.dbPath}`)
}

main()
