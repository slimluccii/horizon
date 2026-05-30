import { loadConfig } from './config.ts'
import { detectHwAccel } from './transcode/hwaccel.ts'
import { openDatabase } from './db/index.ts'
import { migrate } from './db/migrations.ts'
import { createMediaRepo } from './repos/media.ts'
import { createCollectionsRepo } from './repos/collections.ts'
import { createUserRepo } from './repos/users.ts'
import { createProgressRepo } from './repos/progress.ts'
import { createServerSettings } from './repos/serverSettings.ts'
import { createScanRootsRepo, createChangesCursorRepo, createScanHistoryRepo } from './repos/scanState.ts'
import { createTmdbProvider } from './metadata/tmdb.ts'
import { createMetadataRefreshWorker, DEFAULT_REFRESH_CONFIG } from './metadata/refresh.ts'
import { createScanManager } from './scanner/manager.ts'
import { startWatcher, type WatcherHandle } from './scanner/watcher.ts'
import { startDailySchedule, type DailyScheduleHandle } from './scheduler.ts'
import { createSessionManager } from './session/manager.ts'
import { createPlaybackOrchestrator } from './session/playback.ts'
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
  const serverSettings = createServerSettings(db)
  // Overlay env values exactly once (fresh install / first boot after upgrade).
  serverSettings.bootstrapFromEnv(cfg)

  const scanRootsRepo = createScanRootsRepo(db)
  const changesCursorRepo = createChangesCursorRepo(db)
  const scanHistoryRepo = createScanHistoryRepo(db)

  const initialTmdb = createTmdbProvider(cfg.tmdbToken, cfg.cacheDir)

  // Metadata refresh worker — always created so the tmdbToken change handler
  // can swap the client without restarting the server.
  const refreshWorker = createMetadataRefreshWorker(
    {
      ...DEFAULT_REFRESH_CONFIG,
      batchSize: cfg.metadataBatchSize,
      maxAgeMs: {
        movie: cfg.metadataMaxAgeMovieMs,
        show: cfg.metadataMaxAgeShowMs,
        episode: cfg.metadataMaxAgeEpisodeMs,
      },
    },
    { media: mediaRepo, tmdb: initialTmdb, changesCursor: changesCursorRepo },
  )

  const scanManager = createScanManager(cfg, {
    media: mediaRepo,
    collections: collectionsRepo,
    scanRoots: scanRootsRepo,
    scanHistory: scanHistoryRepo,
    onScanFinished: () => { void refreshWorker.run({ useChangesFeed: false }) },  // newly indexed items get metadata fast
  })

  const sessions = createSessionManager(serverSettings)
  const orchestrator = createPlaybackOrchestrator({
    cfg, hwAccel, media: mediaRepo, users: userRepo, sessions, serverSettings,
  })

  const app = await buildServer(
    cfg,
    hwAccel,
    { mediaRepo, collectionsRepo, userRepo, progressRepo, serverSettings },
    sessions,
    { scanManager, refreshWorker, scanHistory: scanHistoryRepo },
    orchestrator,
    db,
  )
  await app.listen({ port: cfg.port, host: '0.0.0.0' })
  console.log(`Horizon listening on :${cfg.port}`)

  // Boot scan: kick after server is accepting traffic so library API doesn't
  // block on first-time indexing of large libraries.
  void scanManager.request({ trigger: 'boot', paths: [] })

  // Filesystem watcher — opt-in for reliable filesystems.
  // Mutable handle so the settings change handler can swap it out.
  let watcherHandle: WatcherHandle | null = null

  function startWatcherIfEnabled(): void {
    const s = serverSettings.get()
    if (s.watchFs) {
      watcherHandle = startWatcher(
        { roots: [...cfg.moviesRoots, ...cfg.showsRoots], debounceMs: s.watchDebounceMs },
        scanManager,
      )
    }
  }

  startWatcherIfEnabled()

  // Nightly schedule: full library scan + (after) a metadata refresh that
  // includes the TMDB /changes feed so pre-existing items pick up upstream
  // edits even when the file didn't change.
  const lastScan = scanRootsRepo.list().reduce((max, r) => Math.max(max, r.lastScannedAt), 0)
  const settings = serverSettings.get()
  let scheduleHandle: DailyScheduleHandle = startDailySchedule({
    hourLocal: settings.scanCronHour,
    catchUpIfOlderThanMs: 36 * 60 * 60 * 1000,    // catch up if missed > 36 h (downtime)
    lastFiredAt: lastScan,
    task: async () => {
      await scanManager.request({ trigger: 'cron', paths: [] })
      await refreshWorker.run({ useChangesFeed: true })
    },
  })

  // Subscribe to settings changes to react to active knobs.
  serverSettings.on('change', ({ patch }) => {
    // tmdbToken change → swap the TMDB client on the refresh worker.
    // In-flight requests on the old client complete; subsequent calls use
    // the new auth header. No process restart needed.
    if (patch.tmdbToken !== undefined) {
      const newTmdb = createTmdbProvider(patch.tmdbToken ?? undefined, cfg.cacheDir)
      refreshWorker.setTmdb(newTmdb)
      console.log(`MetadataRefresh: TMDB client ${newTmdb ? 'updated' : 'cleared'} after token change`)
    }

    // scanCronHour change → reschedule nightly scan.
    if (patch.scanCronHour !== undefined) {
      scheduleHandle.stop()
      scheduleHandle = startDailySchedule({
        hourLocal: patch.scanCronHour,
        catchUpIfOlderThanMs: 36 * 60 * 60 * 1000,
        lastFiredAt: lastScan,
        task: async () => {
          await scanManager.request({ trigger: 'cron', paths: [] })
          await refreshWorker.run({ useChangesFeed: true })
        },
      })
      console.log(`Scheduler: rescheduled nightly scan to ${patch.scanCronHour}:00 local time`)
    }

    // watchFs / watchDebounceMs change → restart watcher.
    if (patch.watchFs !== undefined || patch.watchDebounceMs !== undefined) {
      if (watcherHandle) {
        watcherHandle.stop()
        watcherHandle = null
      }
      const s = serverSettings.get()
      if (s.watchFs) {
        watcherHandle = startWatcher(
          { roots: [...cfg.moviesRoots, ...cfg.showsRoots], debounceMs: s.watchDebounceMs },
          scanManager,
        )
        console.log('Watcher: restarted after settings change')
      } else {
        console.log('Watcher: stopped (watchFs disabled)')
      }
    }
  })
}

main().catch((err) => { console.error(err); process.exit(1) })
