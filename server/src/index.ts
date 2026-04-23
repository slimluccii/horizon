import { loadConfig } from './config.ts'
import { detectHwAccel } from './transcode/hwaccel.ts'
import { openDatabase } from './db/index.ts'
import { migrate } from './db/migrations.ts'
import { createMediaRepo } from './repos/media.ts'
import { createCollectionsRepo } from './repos/collections.ts'
import { createUserRepo } from './repos/users.ts'
import { createProgressRepo } from './repos/progress.ts'
import { createTmdbProvider } from './metadata/tmdb.ts'
import { rescan } from './scanner/scanner.ts'
import { createSessionManager } from './session/manager.ts'
import { buildServer } from './server.ts'

async function main() {
  const cfg = loadConfig()
  const hwAccel = await detectHwAccel(cfg.forceEncoder)

  const db = openDatabase(cfg.dbPath)
  migrate(db)
  const mediaRepo = createMediaRepo(db)
  const collectionsRepo = createCollectionsRepo(db)
  const userRepo = createUserRepo(db)
  const progressRepo = createProgressRepo(db, mediaRepo, {
    watchedThresholdPct: cfg.watchedThresholdPct,
  })
  const tmdb = createTmdbProvider(cfg.tmdbToken, cfg.cacheDir)

  const sessions = createSessionManager(cfg)

  const app = await buildServer(cfg, hwAccel, { mediaRepo, collectionsRepo, userRepo, progressRepo }, sessions)
  await app.listen({ port: cfg.port, host: '0.0.0.0' })
  console.log(`Horizon listening on :${cfg.port}`)

  // Kick off scan after server is accepting traffic so library API doesn't
  // block boot on libraries with many files.
  void rescan(cfg, { media: mediaRepo, collections: collectionsRepo, tmdb })
    .catch(err => console.error('Scan error:', err))
}

main().catch((err) => { console.error(err); process.exit(1) })
