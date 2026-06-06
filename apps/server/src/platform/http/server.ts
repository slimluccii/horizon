import Fastify from 'fastify'
import fastifyWebSocket from '@fastify/websocket'
import fastifyCors from '@fastify/cors'
import type { Config } from '../config/config.ts'
import type { HwAccel } from '../../contexts/playback/index.ts'
import type { ProgressRepo } from '../../contexts/playback/index.ts'
import type { ServerSettings } from '../../contexts/settings/index.ts'
import type { SessionManager } from '../../contexts/playback/index.ts'
import type { MediaRepo, CollectionsRepo, ScanHistoryRepo, ScanManager } from '../../contexts/library/index.ts'
import { registerLibrary } from '../../contexts/library/index.ts'
import type { MetadataRefreshWorker } from '../../contexts/metadata/index.ts'
import type { PlaybackOrchestrator } from '../../contexts/playback/index.ts'
import type { ActivityBus } from '../../contexts/activity/index.ts'
import type { UserRepo, SessionRepo, HouseholdRepo, InviteRepo } from '../../contexts/identity/index.ts'
import { registerAuth, makeRequireAuth, makeResolveProfile, registerUsers, registerInvites, registerHouseholds } from '../../contexts/identity/index.ts'
import { registerHealth } from './health.ts'
import type { Identity } from '../identity/identity.ts'
import { registerSessions } from '../../contexts/playback/index.ts'
import { registerPlaylists } from '../../contexts/playback/index.ts'
import { registerSegments } from '../../contexts/playback/index.ts'
import { registerMetadata } from '../../contexts/metadata/index.ts'
import { registerProgress } from '../../contexts/playback/index.ts'
import { registerSettings } from '../../contexts/settings/index.ts'
import { registerDev } from './dev.ts'
import { registerWeb } from './web.ts'
import { existsSync } from 'node:fs'
import type { DatabaseSync } from '../db/connection.ts'

export interface Repos {
  mediaRepo: MediaRepo
  collectionsRepo: CollectionsRepo
  userRepo: UserRepo
  sessionRepo: SessionRepo
  householdRepo: HouseholdRepo
  inviteRepo: InviteRepo
  progressRepo: ProgressRepo
  serverSettings: ServerSettings
}

export interface ScanWorkers {
  scanManager: ScanManager
  refreshWorker: MetadataRefreshWorker
  scanHistory: ScanHistoryRepo
  activityBus: ActivityBus
}

export async function buildServer(
  cfg: Config,
  hwAccel: HwAccel,
  repos: Repos,
  sessions: SessionManager,
  workers: ScanWorkers,
  orchestrator: PlaybackOrchestrator,
  identity: Identity,
  db?: DatabaseSync,
) {
  const app = Fastify({ logger: true })

  await app.register(fastifyCors, {
    // '*' → reflect any origin; a non-empty list → allow exactly those;
    // empty (the default) → disable CORS entirely (same-origin only), which is
    // correct when the web UI is served from this server or via the dev proxy.
    origin: cfg.corsOrigins.includes('*') ? true : (cfg.corsOrigins.length ? cfg.corsOrigins : false),
  })
  await app.register(fastifyWebSocket)

  // All API routes live under the `/api` prefix, inside one encapsulated plugin.
  // This is the clean API/web split: the session guard is an onRequest hook
  // scoped to THIS plugin, so it never runs for the web UI (`/`, `/login`,
  // `/play/:id`, static assets, SPA fallback) served at the root below. No
  // path-allowlist of open-ended client routes — anything not under /api is web.
  await app.register(async (api) => {
    // Auth routes also register @fastify/cookie so `req.cookies` is populated
    // before the guard reads the session cookie.
    await registerAuth(api, repos.userRepo, repos.sessionRepo, repos.householdRepo)

    const requireAuth = makeRequireAuth(repos.sessionRepo, repos.userRepo)
    api.addHook('onRequest', async (req, reply) => {
      // First-boot bootstrap: creating the very first profile (auto-elected
      // owner) must be reachable before any session can exist. POST /api/users
      // self-gates (only unauthenticated while the household is empty), so it's
      // safe to bypass the guard for that one request.
      const path = req.routeOptions?.url ?? req.url.split('?')[0]
      if (req.method === 'POST' && path === '/api/users' && repos.userRepo.list().length === 0) return
      return requireAuth(req, reply)
    })

    // resolveProfile runs after requireAuth and sets req.profileUserId from the
    // X-Horizon-Profile header (defaulting to the principal). Per-user routes key
    // their acting user off req.profileUserId, so this hook must be installed in
    // production — not just in the route tests.
    api.addHook('preHandler', makeResolveProfile(repos.sessionRepo, repos.userRepo))

    registerHealth(api, hwAccel, identity)
    registerLibrary(api, repos.mediaRepo, repos.collectionsRepo, workers, repos.userRepo, cfg)
    registerSessions(api, cfg, hwAccel, sessions, repos.progressRepo, orchestrator, repos.serverSettings, repos.userRepo)
    registerPlaylists(api, sessions, repos.userRepo)
    registerSegments(api, hwAccel, sessions, repos.mediaRepo, repos.userRepo)
    registerMetadata(api, cfg)
    registerUsers(api, repos.userRepo, repos.sessionRepo, repos.householdRepo)
    registerInvites(api, { users: repos.userRepo, sessions: repos.sessionRepo, households: repos.householdRepo, invites: repos.inviteRepo })
    registerHouseholds(api, { users: repos.userRepo, households: repos.householdRepo })
    registerProgress(api, repos.userRepo, repos.progressRepo)
    registerSettings(api, repos.userRepo, repos.serverSettings, cfg)

    if (cfg.devSeedEnabled && db) {
      api.log.warn('HORIZON_DEV_SEED=1 — exposing POST /api/dev/seed/:scenario. DO NOT enable in production.')
      registerDev(api, { media: repos.mediaRepo, collections: repos.collectionsRepo, db })
    }
  }, { prefix: '/api' })

  // Web UI at the root, OUTSIDE the /api plugin → never hits the auth guard.
  // Its catch-all SPA fallback is registered last so it can't shadow /api.
  if (cfg.serveWeb && cfg.webDir) {
    if (existsSync(cfg.webDir)) {
      await registerWeb(app, cfg.webDir)
    } else {
      app.log.warn(`HORIZON_WEB_DIR=${cfg.webDir} does not exist — web UI not served`)
    }
  }

  return app
}
