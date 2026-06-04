import path from 'node:path'
import { runScan, fullScope, classifyPath, type ScanConfig, type ScanDeps, type ScanResult, type ScanScope } from './scanner.ts'
import type { ScanHistoryRepo, ScanRootsRepo, ScanTrigger } from '../repos/scanState.ts'
import type { ActivityBus } from '../activity/bus.ts'

export interface ScanManagerDeps extends ScanDeps {
  scanRoots: ScanRootsRepo
  scanHistory: ScanHistoryRepo
  /** Optional activity bus for live scan/metadata events. */
  bus?: ActivityBus
  /** Optional metadata-refresh trigger run after each scan finishes. */
  onScanFinished?: (result: ScanResult) => void | Promise<void>
  /** Live library roots, read fresh on every scan so runtime root changes
   *  (PATCH /settings/server) take effect with no restart. Replaces the static
   *  cfg.moviesRoots/cfg.showsRoots. */
  getRoots: () => { movies: string[]; shows: string[] }
}

export interface ScanStatus {
  running: boolean
  current: {
    trigger: ScanTrigger
    scope: 'full' | string
    startedAt: number
    /** Live progress: items probed so far / total discovered so far. `total`
     *  grows as roots are walked, then stabilises; both 0 before the first
     *  walk completes. */
    processed: number
    total: number
  } | null
  pendingPaths: string[]
  lastResult: ScanResult | null
  lastFinishedAt: number | null
  rootBookkeeping: { rootPath: string; lastScannedAt: number; lastDurationMs: number; lastSeenCount: number }[]
}

export interface ScanRequest {
  trigger: ScanTrigger
  /** Sub-paths to scan. Empty array = full scan. */
  paths: string[]
}

export interface ScanManager {
  /** Request a scan. If one is running, paths queue and a follow-up runs after. */
  request(req: ScanRequest): Promise<ScanResult | 'queued'>
  status(): ScanStatus
  /** Stop accepting new requests + wait for current to finish. */
  shutdown(): Promise<void>
}

const SCAN_HISTORY_KEEP = 100

/**
 * Single-flight scan dispatcher.
 *
 * Properties:
 *  - At most one scan runs at a time.
 *  - Concurrent requests for sub-paths coalesce into one follow-up scan.
 *  - A "full" request (paths=[]) supersedes any pending sub-path queue.
 *  - Overlapping/redundant sub-paths are pruned (deeper paths absorbed by ancestors).
 *
 * Scope coalescing example:
 *  request(['/movies/A/B']) → running
 *  request(['/movies/A'])   → A absorbs A/B; pending = {/movies/A}
 *  request(['/shows/X'])    → pending = {/movies/A, /shows/X}
 *  request([])              → pending becomes "full" — discard sub-paths
 */
export function createScanManager(cfg: ScanConfig, deps: ScanManagerDeps): ScanManager {
  type Pending = { trigger: ScanTrigger; full: boolean; paths: Set<string> }

  // Overlay the live library roots (from serverSettings via deps.getRoots) onto
  // the static cfg, read fresh on each scan. cfg no longer carries roots —
  // they're runtime-settable, so fullScope/classifyPath/bookkeeping all read
  // through this rather than cfg.moviesRoots/cfg.showsRoots directly.
  function liveCfg(): ScanConfig {
    const { movies, shows } = deps.getRoots()
    const norm = (r: string) => path.resolve(r).replace(/\/+$/, '')
    return { ...cfg, moviesRoots: movies.map(norm), showsRoots: shows.map(norm) }
  }

  let running: { trigger: ScanTrigger; scope: 'full' | string; startedAt: number; processed: number; total: number } | null = null
  let runningPromise: Promise<ScanResult> | null = null
  let pending: Pending | null = null
  let pendingResolvers: Array<(r: ScanResult) => void> = []
  let lastResult: ScanResult | null = null
  let lastFinishedAt: number | null = null
  let shuttingDown = false

  function mergeIntoPending(req: ScanRequest): void {
    if (!pending) {
      pending = {
        trigger: req.trigger,
        full: req.paths.length === 0,
        paths: new Set(req.paths.length === 0 ? [] : req.paths),
      }
      return
    }
    // Already pending — promote trigger if this one is "stronger" (manual > cron > watcher).
    const order: Record<ScanTrigger, number> = { manual: 4, boot: 3, cron: 2, watcher: 1, metadata: 0 }
    if (order[req.trigger] > order[pending.trigger]) pending.trigger = req.trigger

    if (req.paths.length === 0 || pending.full) {
      pending.full = true
      pending.paths.clear()
      return
    }
    for (const p of req.paths) pending.paths.add(p)
    // Collapse: if any path is an ancestor of another, drop the descendant.
    const arr = [...pending.paths].sort()
    pending.paths.clear()
    for (const p of arr) {
      let absorbed = false
      for (const existing of pending.paths) {
        if (p === existing || p.startsWith(`${existing}/`)) { absorbed = true; break }
      }
      if (!absorbed) {
        // Drop any existing path that is a descendant of `p`.
        for (const existing of [...pending.paths]) {
          if (existing.startsWith(`${p}/`)) pending.paths.delete(existing)
        }
        pending.paths.add(p)
      }
    }
  }

  function pendingToScope(p: Pending): ScanScope {
    const live = liveCfg()
    if (p.full) return fullScope(live)
    const moviesPaths: string[] = []
    const showsPaths: string[] = []
    for (const sub of p.paths) {
      const k = classifyPath(sub, live)
      if (k === 'movies') moviesPaths.push(sub)
      else if (k === 'shows') showsPaths.push(sub)
      // Unmatched paths are silently dropped — likely watcher event for a
      // sibling dir (e.g. .DS_Store), not a configured root.
    }
    return { moviesPaths, showsPaths, fullScope: false }
  }

  async function executeOne(p: Pending): Promise<ScanResult> {
    const scope = pendingToScope(p)
    const scopeLabel = p.full ? 'full' : [...p.paths].sort().join(',')
    const startedAt = Date.now()
    running = { trigger: p.trigger, scope: scopeLabel, startedAt, processed: 0, total: 0 }
    deps.bus?.emit({ kind: 'scan:start', trigger: p.trigger, scope: scopeLabel, message: `Scan started (${p.trigger}, ${scopeLabel})` })
    // Live progress sink — mutates the `running` snapshot read by status().
    let lastProgressEmit = 0
    const progress = {
      addTotal(n: number) { if (running) running.total += n },
      tick() {
        if (running) running.processed += 1
        const t = Date.now()
        if (running && t - lastProgressEmit >= 200) {
          lastProgressEmit = t
          deps.bus?.emit({ kind: 'scan:progress', processed: running.processed, total: running.total, message: `Scanned ${running.processed}/${running.total}` })
        }
      },
    }
    const histId = deps.scanHistory.begin(p.trigger, p.full ? 'full' : scopeLabel, startedAt)
    const errors: string[] = []
    let result: ScanResult
    try {
      result = await runScan(scope, cfg, { media: deps.media, collections: deps.collections, bus: deps.bus }, progress)
    } catch (err) {
      errors.push((err as Error).message)
      result = {
        scope, itemsSeen: 0, itemsAdded: 0, itemsRemoved: 0, itemsFailed: 0,
        durationMs: Date.now() - startedAt,
        movies: 0, shows: 0, episodes: 0,
      }
      console.error('Scan error:', err)
    }
    const finishedAt = Date.now()
    deps.scanHistory.finish(histId, {
      finishedAt,
      itemsSeen: result.itemsSeen,
      itemsAdded: result.itemsAdded,
      itemsRemoved: result.itemsRemoved,
      metadataRefreshed: 0,
      errors,
    })
    deps.scanHistory.prune(SCAN_HISTORY_KEEP)

    // Update per-root bookkeeping for everything we scanned.
    const { movies, shows } = deps.getRoots()
    const rootsTouched = p.full
      ? [...movies, ...shows]
      : [...p.paths]
    for (const r of rootsTouched) {
      // Approximate per-root counts — we don't break out per root inside runScan.
      deps.scanRoots.set({
        rootPath: r,
        lastScannedAt: finishedAt,
        lastDurationMs: result.durationMs,
        lastSeenCount: result.itemsSeen,
      })
    }
    lastResult = result
    lastFinishedAt = finishedAt
    running = null
    deps.bus?.emit({
      kind: 'scan:done',
      movies: result.movies, shows: result.shows,
      added: result.itemsAdded, removed: result.itemsRemoved, failed: result.itemsFailed,
      durationMs: result.durationMs,
      message: `Scan done · ${result.movies} movies, ${result.shows} series (+${result.itemsAdded} −${result.itemsRemoved})`,
    })

    if (deps.onScanFinished) {
      try { await deps.onScanFinished(result) }
      catch (e) { console.error('onScanFinished hook error:', e) }
    }
    return result
  }

  async function drainLoop(): Promise<ScanResult> {
    // Drain pending until empty. Returns the LAST result.
    let last: ScanResult | null = null
    while (pending) {
      const next = pending
      pending = null
      const resolvers = pendingResolvers
      pendingResolvers = []
      const r = await executeOne(next)
      last = r
      for (const res of resolvers) res(r)
    }
    runningPromise = null
    return last!
  }

  return {
    async request(req) {
      if (shuttingDown) throw new Error('ScanManager shutting down')
      // Normalize paths (resolve relative, drop trailing slashes).
      const normalizedPaths = req.paths.map(p => path.resolve(p).replace(/\/+$/, ''))
      const norm: ScanRequest = { trigger: req.trigger, paths: normalizedPaths }

      if (runningPromise) {
        // Coalesce into pending; resolve when next drain completes.
        mergeIntoPending(norm)
        return new Promise<ScanResult>((resolve) => {
          pendingResolvers.push(resolve)
        })
      }
      // No-op if already a no-op-equivalent: nothing to do AND no roots configured.
      mergeIntoPending(norm)
      runningPromise = drainLoop()
      return runningPromise
    },

    status() {
      return {
        running: running !== null,
        current: running,
        pendingPaths: pending ? (pending.full ? ['*full*'] : [...pending.paths].sort()) : [],
        lastResult,
        lastFinishedAt,
        rootBookkeeping: deps.scanRoots.list(),
      }
    },

    async shutdown() {
      shuttingDown = true
      if (runningPromise) await runningPromise.catch(() => {/* ignore */})
    },
  }
}
