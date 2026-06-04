import { loadConfig } from './config.ts'
import { detectHwAccel } from './transcode/hwaccel.ts'
import { openDatabase } from './db/index.ts'
import { migrate } from './db/migrations.ts'
import { createMediaRepo } from './repos/media.ts'
import { createCollectionsRepo } from './repos/collections.ts'
import { createUserRepo } from './repos/users.ts'
import { createSessionRepo } from './auth/session.ts'
import { createProgressRepo } from './repos/progress.ts'
import { createServerSettings } from './contexts/settings/index.ts'
import { createScanRootsRepo, createChangesCursorRepo, createScanHistoryRepo } from './repos/scanState.ts'
import { createTmdbProvider } from './metadata/tmdb.ts'
import { createMetadataRefreshWorker, DEFAULT_REFRESH_CONFIG } from './metadata/refresh.ts'
import { createScanManager } from './scanner/manager.ts'
import { startWatcher, type WatcherHandle } from './scanner/watcher.ts'
import { startDailySchedule, type DailyScheduleHandle } from './scheduler.ts'
import { createSessionManager } from './session/manager.ts'
import { createPlaybackOrchestrator } from './session/playback.ts'
import { buildServer } from './server.ts'
import { createActivityBus } from './contexts/activity/index.ts'

async function main() {
  const cfg = loadConfig()

  // Hard fail-fast: the dev-seed routes are destructive and unauthenticated.
  // Never let them be exposed in a production deployment, even by accident.
  if (cfg.devSeedEnabled && cfg.nodeEnv === 'production') {
    console.error('ERROR: HORIZON_DEV_SEED=1 with NODE_ENV=production is not allowed. Dev seed routes cannot be exposed in production.')
    process.exit(1)
  }

  const hwAccel = await detectHwAccel(cfg.forceEncoder)

  const db = openDatabase(cfg.dbPath)
  migrate(db)
  const mediaRepo = createMediaRepo(db)
  const collectionsRepo = createCollectionsRepo(db)
  const userRepo = createUserRepo(db)

  // Owner-lockout escape hatch (DEPLOY.md → "Owner lockout escape hatch"):
  // boot once with HORIZON_RESET_OWNER_PASSWORD=1 to clear the owner's password
  // hash + failed-attempt/lockout state, forcing them back through the
  // set-password flow like first boot. One-shot — the operator removes the var
  // and restarts afterwards (leaving it set wipes the owner's password on every
  // boot). Read directly from the env so it bypasses the seeded ServerSettings
  // overlay and works even when the DB row already exists.
  if (process.env.HORIZON_RESET_OWNER_PASSWORD === '1') {
    const ownerName = userRepo.resetOwnerPassword()
    if (ownerName) {
      console.warn(
        `HORIZON_RESET_OWNER_PASSWORD=1: cleared password + lockout for owner "${ownerName}". ` +
        'Owner must set a new password on next login. Unset this variable and restart.',
      )
    } else {
      console.warn('HORIZON_RESET_OWNER_PASSWORD=1: no owner row found; nothing to reset.')
    }
  }

  const sessionRepo = createSessionRepo(db)
  // Boot sweep of expired sessions (incremental cleanup also happens on resolve).
  sessionRepo.sweepExpired()
  const serverSettings = createServerSettings(db)
  // Overlay env values exactly once (fresh install / first boot after upgrade).
  serverSettings.bootstrapFromEnv(cfg)

  const progressRepo = createProgressRepo(db, mediaRepo, {
    getWatchedThresholdPct: () => serverSettings.get().watchedThresholdPct,
  })

  const scanRootsRepo = createScanRootsRepo(db)
  const changesCursorRepo = createChangesCursorRepo(db)
  const scanHistoryRepo = createScanHistoryRepo(db)

  const initialTmdb = createTmdbProvider(cfg.tmdbToken, cfg.cacheDir)

  // Metadata refresh worker — always created so the tmdbToken change handler
  // can swap the client without restarting the server.
  //
  // Config is supplied as a LIVE getter: batchSize + maxAgeMs are read from
  // serverSettings on every run(), so PATCH /settings/server changes take
  // effect on the next run with no restart (CONTEXT.md → ServerSettings thunk
  // pattern). metadataMaxAge* is stored in days; convert to ms at this edge.
  const DAY_MS = 86_400_000
  const activityBus = createActivityBus()
  const refreshWorker = createMetadataRefreshWorker(
    () => ({
      ...DEFAULT_REFRESH_CONFIG,
      batchSize: serverSettings.get().metadataBatchSize,
      maxAgeMs: {
        movie: serverSettings.get().metadataMaxAgeMovieDays * DAY_MS,
        show: serverSettings.get().metadataMaxAgeShowDays * DAY_MS,
        episode: serverSettings.get().metadataMaxAgeEpDays * DAY_MS,
      },
    }),
    { media: mediaRepo, tmdb: initialTmdb, changesCursor: changesCursorRepo, bus: activityBus },
  )

  // Library roots live in serverSettings now (runtime-settable), so the scanner
  // + watcher read them fresh via these thunks rather than from static cfg.
  const getRoots = (): { movies: string[]; shows: string[] } => {
    const s = serverSettings.get()
    return { movies: s.moviesRoots, shows: s.showsRoots }
  }
  const currentWatchRoots = (): string[] => {
    const { movies, shows } = getRoots()
    return [...movies, ...shows]
  }

  const scanManager = createScanManager(cfg, {
    media: mediaRepo,
    collections: collectionsRepo,
    scanRoots: scanRootsRepo,
    scanHistory: scanHistoryRepo,
    // After a scan, drain the whole metadata queue so newly-indexed items get
    // FULL enrichment in one pass (not batchSize-at-a-time). Serial; the TMDB
    // provider's concurrency cap + per-item backoff keep it well-behaved.
    onScanFinished: () => { void refreshWorker.run({ useChangesFeed: false, drain: true }) },
    getRoots,
    bus: activityBus,
  })

  const sessions = createSessionManager(serverSettings)
  const orchestrator = createPlaybackOrchestrator({
    cfg, hwAccel, media: mediaRepo, users: userRepo, sessions, serverSettings,
  })

  const app = await buildServer(
    cfg,
    hwAccel,
    { mediaRepo, collectionsRepo, userRepo, sessionRepo, progressRepo, serverSettings },
    sessions,
    { scanManager, refreshWorker, scanHistory: scanHistoryRepo, activityBus },
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
        { roots: currentWatchRoots(), debounceMs: s.watchDebounceMs },
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

  // Snapshot the current root set so each change event can diff added/removed.
  let previousRoots = currentWatchRoots()

  // Subscribe to settings changes to react to active knobs.
  serverSettings.on('change', ({ patch }) => {
    // tmdbToken change → swap the TMDB client on the refresh worker.
    // In-flight requests on the old client complete; subsequent calls use
    // the new auth header. No process restart needed.
    if (patch.tmdbToken !== undefined) {
      // Audit trail — NEVER log the token value, only that it changed.
      console.log(`Server settings: TMDB token ${patch.tmdbToken ? 'updated' : 'cleared'}`)
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

    // moviesRoots / showsRoots change → diff added/removed roots. Added roots
    // get a subtree scan; removed roots are pruned immediately (soft-delete
    // everything under the prefix) and their orphaned watch-progress is cleaned.
    // The watcher is then restarted below so it tracks the new root set.
    if (patch.moviesRoots !== undefined || patch.showsRoots !== undefined) {
      const nextRoots = currentWatchRoots()
      const prevSet = new Set(previousRoots)
      const nextSet = new Set(nextRoots)
      const added = nextRoots.filter(r => !prevSet.has(r))
      const removed = previousRoots.filter(r => !nextSet.has(r))
      previousRoots = nextRoots

      if (added.length > 0) {
        void scanManager.request({ trigger: 'manual', paths: added })
      }
      for (const root of removed) {
        const pruned = mediaRepo.softDeleteMissingUnder(root, new Set())
        const orphaned = progressRepo.deleteOrphaned()
        console.log(`Library root removed: ${root} (pruned ${pruned} items, cleaned ${orphaned} progress rows)`)
      }

      // Restart the watcher with the new root set.
      if (watcherHandle) {
        watcherHandle.stop()
        watcherHandle = null
      }
      const s = serverSettings.get()
      if (s.watchFs) {
        watcherHandle = startWatcher(
          { roots: currentWatchRoots(), debounceMs: s.watchDebounceMs },
          scanManager,
        )
        console.log('Watcher: restarted after library roots change')
      }
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
          { roots: currentWatchRoots(), debounceMs: s.watchDebounceMs },
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
