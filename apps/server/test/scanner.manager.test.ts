import { describe, it, expect } from 'vitest'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createMediaRepo } from '../src/repos/media.ts'
import { createCollectionsRepo } from '../src/repos/collections.ts'
import { createScanRootsRepo, createScanHistoryRepo } from '../src/repos/scanState.ts'
import { createScanManager } from '../src/scanner/manager.ts'
import type { ScanScope } from '../src/scanner/scanner.ts'

const baseCfg = {
  moviesRoots: ['/nonexistent/movies'],
  showsRoots: ['/nonexistent/shows'],
  cacheDir: '/tmp/horizon-test-cache',
  scanConcurrency: 1,
}

function setup() {
  const db = openDatabase(':memory:')
  migrate(db)
  return {
    media: createMediaRepo(db),
    collections: createCollectionsRepo(db),
    scanRoots: createScanRootsRepo(db),
    scanHistory: createScanHistoryRepo(db),
    // Live roots thunk — returns the static baseCfg roots so the manager scans
    // the same paths the old static-cfg version did.
    getRoots: () => ({ movies: baseCfg.moviesRoots, shows: baseCfg.showsRoots }),
  }
}

describe('ScanManager', () => {
  it('runs a full scan when paths is empty', async () => {
    const deps = setup()
    const mgr = createScanManager(baseCfg, deps)
    const r = await mgr.request({ trigger: 'manual', paths: [] })
    expect(r).not.toBe('queued')
    if (r !== 'queued') {
      expect(r.itemsSeen).toBe(0)
      expect(r.scope.fullScope).toBe(true)
    }
  })

  it('coalesces overlapping subtree requests into a single follow-up scan', async () => {
    const deps = setup()
    let scanCount = 0
    const cfg = baseCfg
    // Wrap manager with a counting onScanFinished so we can observe how many
    // times it actually executed runScan.
    const mgr = createScanManager(cfg, {
      ...deps,
      onScanFinished: () => { scanCount++ },
    })
    // Fire three requests in same tick. First runs immediately; the others
    // coalesce into one follow-up.
    const p1 = mgr.request({ trigger: 'watcher', paths: ['/nonexistent/movies/A/B'] })
    const p2 = mgr.request({ trigger: 'watcher', paths: ['/nonexistent/movies/A'] })
    const p3 = mgr.request({ trigger: 'watcher', paths: ['/nonexistent/shows/X'] })
    await Promise.all([p1, p2, p3])
    // Either 1 or 2 scans depending on timing; never 3.
    expect(scanCount).toBeGreaterThanOrEqual(1)
    expect(scanCount).toBeLessThanOrEqual(2)
  })

  it('full request supersedes pending sub-paths', async () => {
    const deps = setup()
    const seenScopes: ScanScope[] = []
    const mgr = createScanManager(baseCfg, {
      ...deps,
      onScanFinished: (r) => { seenScopes.push(r.scope) },
    })
    const p1 = mgr.request({ trigger: 'watcher', paths: ['/nonexistent/movies/A'] })
    // Queue a full scan while the first runs.
    const p2 = mgr.request({ trigger: 'manual', paths: [] })
    await Promise.all([p1, p2])
    // The follow-up after first finishes should be a full scope.
    const lastScope = seenScopes.at(-1)
    expect(lastScope?.fullScope).toBe(true)
  })

  it('writes to scan history with the correct trigger', async () => {
    const deps = setup()
    const mgr = createScanManager(baseCfg, deps)
    await mgr.request({ trigger: 'cron', paths: [] })
    const recent = deps.scanHistory.recent(10)
    expect(recent.length).toBeGreaterThan(0)
    expect(recent[0].trigger).toBe('cron')
    expect(recent[0].scope).toBe('full')
    expect(recent[0].finishedAt).not.toBeNull()
  })

  it('updates scan_roots after a successful run', async () => {
    const deps = setup()
    const mgr = createScanManager(baseCfg, deps)
    await mgr.request({ trigger: 'boot', paths: [] })
    const roots = deps.scanRoots.list()
    expect(roots.length).toBe(2)                 // movies + shows
    for (const r of roots) {
      expect(r.lastScannedAt).toBeGreaterThan(0)
    }
  })
})
