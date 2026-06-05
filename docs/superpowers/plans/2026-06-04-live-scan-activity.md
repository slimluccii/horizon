# Live Scan & Metadata Activity Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the polled scan status into a real-time activity feed — live phase + Movies/Series counts during the scan, a per-item metadata step sequence (detected → searching → matched → fetching → fetched → stored/failed), and a toggleable raw-output log panel (owner/admin).

**Architecture:** An in-process activity bus (ring buffer + subscribers) that the scan manager, scanner, and metadata worker emit to; a Server-Sent-Events endpoint streams events; the web subscribes via `EventSource` and folds events through a pure reducer into the expanded scan badge + a raw-log panel.

**Tech Stack:** TypeScript, Node, Fastify (SSE via `reply.hijack` + `reply.raw`), better-sqlite3, Vitest, React + react-router, EventSource.

---

## File Structure

- Create: `libs/sdk/src/activity.ts` — shared `ActivityEvent` union + `MetaStep`/`MediaKind` + `ACTIVITY_STREAM_PATH`.
- Create: `apps/server/src/activity/bus.ts` — `ActivityBus` (ring buffer + subscribers).
- Create: `apps/server/test/activity.bus.test.ts`.
- Modify: `apps/server/src/scanner/scanner.ts` — `ScanDeps.bus`, `ScanResult` counts, emit `scan:detected`.
- Modify: `apps/server/src/scanner/manager.ts` — emit `scan:start`/`scan:progress`/`scan:done`.
- Modify: `apps/server/test/scanner.integration.test.ts` — assert emitted events.
- Modify: `apps/server/src/metadata/refresh.ts` — `MetadataRefreshDeps.bus`, emit per-item steps + `meta:start`/`meta:done`.
- Modify: `apps/server/test/metadata.refresh.test.ts` (or create if absent) — assert step sequences.
- Modify: `apps/server/src/server.ts` — `ScanWorkers.activityBus`.
- Modify: `apps/server/src/index.ts` — create bus, inject into manager + worker + workers.
- Modify: `apps/server/src/routes/library.ts` — `GET /library/activity/stream` SSE route.
- Create: `apps/server/test/routes.activity.test.ts`.
- Create: `apps/web/src/hooks/useActivityStream.ts` — EventSource + pure `activityReducer`.
- Create: `libs/sdk/test/` not needed; reducer test lives in web.
- Create: `apps/web/test/activityReducer.test.ts` (web vitest) OR co-locate — see Task 7 for the runner.
- Create: `apps/web/src/components/ActivityLogPanel.tsx` (+ `ActivityLogPanel.css`).
- Modify: `apps/web/src/pages/Settings.tsx` — extend `ScanStatusBadge`.

---

### Task 1: Shared activity event types (SDK)

**Files:**
- Create: `libs/sdk/src/activity.ts`
- Modify: `libs/sdk/src/index.ts`

- [ ] **Step 1: Create the types file**

Create `libs/sdk/src/activity.ts`:

```ts
export type MediaKind = 'movie' | 'show' | 'episode'

export type MetaStep =
  | 'detected'
  | 'resolving-show'
  | 'searching'
  | 'matched'
  | 'fetching'
  | 'fetched'
  | 'stored'
  | 'failed'

interface Base { seq: number; ts: number; message: string }

export type ActivityEvent =
  | (Base & { kind: 'scan:start'; trigger: string; scope: string })
  | (Base & { kind: 'scan:progress'; processed: number; total: number })
  | (Base & { kind: 'scan:detected'; mediaKind: MediaKind; title: string })
  | (Base & { kind: 'scan:done'; movies: number; shows: number; added: number; removed: number; failed: number; durationMs: number })
  | (Base & { kind: 'meta:start' })
  | (Base & { kind: 'meta:item'; step: MetaStep; mediaKind: MediaKind; title: string; tmdbId?: number; reason?: string; cached?: boolean })
  | (Base & { kind: 'meta:done'; refreshed: number; failed: number; durationMs: number })
  | (Base & { kind: 'error'; code: string })

/** An event before the bus stamps seq + ts. */
export type ActivityEventInput =
  ActivityEvent extends infer E
    ? E extends ActivityEvent ? Omit<E, 'seq' | 'ts'> : never
    : never

export const ACTIVITY_STREAM_PATH = '/api/library/activity/stream'
```

- [ ] **Step 2: Export from the barrel**

In `libs/sdk/src/index.ts`, add: `export * from './activity.ts'`

- [ ] **Step 3: Typecheck**

Run: `npm -w @horizon/sdk run build`
Expected: compiles. (Pre-existing `test/client.test.ts` tsc errors are unrelated and may appear — they exist on `main`.)

- [ ] **Step 4: Commit**

```bash
git add libs/sdk/src/activity.ts libs/sdk/src/index.ts
git commit -m "feat(sdk): shared ActivityEvent types for scan activity stream"
```

---

### Task 2: Activity bus

**Files:**
- Create: `apps/server/src/activity/bus.ts`
- Test: `apps/server/test/activity.bus.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/activity.bus.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createActivityBus } from '../src/activity/bus.ts'

describe('activity bus', () => {
  it('stamps monotonic seq + ts and buffers in order', () => {
    let t = 100
    const bus = createActivityBus({ bufferSize: 10, now: () => t++ })
    bus.emit({ kind: 'meta:start', message: 'a' })
    bus.emit({ kind: 'meta:done', refreshed: 1, failed: 0, durationMs: 5, message: 'b' })
    const r = bus.recent()
    expect(r.map(e => e.seq)).toEqual([0, 1])
    expect(r.map(e => e.ts)).toEqual([100, 101])
    expect(r.map(e => e.message)).toEqual(['a', 'b'])
  })

  it('caps the ring buffer, dropping oldest', () => {
    const bus = createActivityBus({ bufferSize: 3, now: () => 0 })
    for (let i = 0; i < 5; i++) bus.emit({ kind: 'error', code: 'x', message: String(i) })
    expect(bus.recent().map(e => e.message)).toEqual(['2', '3', '4'])
  })

  it('delivers to subscribers and stops after unsubscribe', () => {
    const bus = createActivityBus({ now: () => 0 })
    const seen: string[] = []
    const off = bus.subscribe(e => seen.push(e.message))
    bus.emit({ kind: 'error', code: 'x', message: 'one' })
    off()
    bus.emit({ kind: 'error', code: 'x', message: 'two' })
    expect(seen).toEqual(['one'])
  })

  it('drops a subscriber that throws without breaking emit', () => {
    const bus = createActivityBus({ now: () => 0 })
    const good: string[] = []
    bus.subscribe(() => { throw new Error('bad') })
    bus.subscribe(e => good.push(e.message))
    expect(() => bus.emit({ kind: 'error', code: 'x', message: 'ok' })).not.toThrow()
    bus.emit({ kind: 'error', code: 'x', message: 'ok2' })
    expect(good).toEqual(['ok', 'ok2'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm -w @horizon/server exec vitest run test/activity.bus.test.ts`
Expected: FAIL — `createActivityBus` not found.

- [ ] **Step 3: Implement the bus**

Create `apps/server/src/activity/bus.ts`:

```ts
import type { ActivityEvent, ActivityEventInput } from '@horizon/sdk'

export interface ActivityBus {
  emit(evt: ActivityEventInput): void
  subscribe(fn: (evt: ActivityEvent) => void): () => void
  recent(): ActivityEvent[]
}

export function createActivityBus(opts?: { bufferSize?: number; now?: () => number }): ActivityBus {
  const bufferSize = opts?.bufferSize ?? 500
  const now = opts?.now ?? Date.now
  const buffer: ActivityEvent[] = []
  const subs = new Set<(evt: ActivityEvent) => void>()
  let seq = 0

  return {
    emit(input) {
      const evt = { ...input, seq: seq++, ts: now() } as ActivityEvent
      buffer.push(evt)
      if (buffer.length > bufferSize) buffer.shift()
      for (const fn of [...subs]) {
        try { fn(evt) } catch { subs.delete(fn) }
      }
    },
    subscribe(fn) {
      subs.add(fn)
      return () => { subs.delete(fn) }
    },
    recent() {
      return [...buffer]
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm -w @horizon/server exec vitest run test/activity.bus.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/activity/bus.ts apps/server/test/activity.bus.test.ts
git commit -m "feat(server): in-memory activity bus (ring buffer + subscribers)"
```

---

### Task 3: Scanner + manager emit scan events

**Files:**
- Modify: `apps/server/src/scanner/scanner.ts`
- Modify: `apps/server/src/scanner/manager.ts`
- Test: `apps/server/test/scanner.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Read the top of `apps/server/test/scanner.integration.test.ts` to reuse its temp-dir + repo harness. Add this test (adapt helper names to the file's existing ones — it uses sync fs + inline repos):

```ts
it('emits scan:detected per movie/show and scan:done with counts', async () => {
  const root = makeTempLib()        // adapt: dir with one movie + one show+episode
  // e.g. root/movies/Inception (2010).mkv  and  root/tv/Breaking Bad/S01E01.mkv
  const { media, collections } = makeRepos()
  const events: any[] = []
  const bus = { emit: (e: any) => events.push(e), subscribe: () => () => {}, recent: () => [] }
  const cfg = { moviesRoots: [join(root, 'movies')], showsRoots: [join(root, 'tv')], cacheDir: root, scanConcurrency: 2 }
  const res = await runScan(fullScope(cfg), cfg, { media, collections, bus })

  const detected = events.filter(e => e.kind === 'scan:detected')
  expect(detected.some(e => e.mediaKind === 'movie' && e.title === 'Inception')).toBe(true)
  expect(detected.some(e => e.mediaKind === 'show' && e.title === 'Breaking Bad')).toBe(true)
  expect(detected.some(e => e.mediaKind === 'episode')).toBe(false) // episodes not emitted
  expect(res.movies).toBe(1)
  expect(res.shows).toBe(1)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm -w @horizon/server exec vitest run test/scanner.integration.test.ts`
Expected: FAIL — `runScan` ignores `bus`; `res.movies` undefined.

- [ ] **Step 3: Extend `ScanDeps` + `ScanResult` and emit detected (scanner.ts)**

In `apps/server/src/scanner/scanner.ts`:

Add the import at the top:

```ts
import type { ActivityBus } from '../activity/bus.ts'
```

Extend `ScanDeps`:

```ts
export interface ScanDeps {
  media: MediaRepo
  collections: CollectionsRepo
  bus?: ActivityBus
}
```

Extend `ScanResult` (add the three count fields):

```ts
export interface ScanResult {
  scope: ScanScope
  itemsSeen: number
  itemsAdded: number
  itemsRemoved: number
  itemsFailed: number
  durationMs: number
  movies: number
  shows: number
  episodes: number
}
```

In `scanMoviesPath`, change its signature to accept the bus and return a movie count. Replace its signature line and the success branch:

```ts
async function scanMoviesPath(
  pathToScan: string,
  cfg: ScanConfig,
  media: MediaRepo,
  progress: ScanProgressReporter,
  bus?: ActivityBus,
): Promise<{ seen: Set<string>; added: number; failed: number }> {
```

In the success branch (right after `media.upsertMovie(upsert)` / `seen.add(id)`), emit detected:

```ts
    media.upsertMovie(upsert)
    seen.add(id)
    if (!existed) added++
    bus?.emit({ kind: 'scan:detected', mediaKind: 'movie', title: m[1].trim(), message: `Detected movie "${m[1].trim()}"` })
    progress.tick()
```

In `scanShowsPath`, accept the bus and emit detected when a show is upserted. Change its signature:

```ts
async function scanShowsPath(
  pathToScan: string,
  cfg: ScanConfig,
  media: MediaRepo,
  progress: ScanProgressReporter,
  bus?: ActivityBus,
): Promise<{ seen: Set<string>; added: number; failed: number }> {
```

In the per-show upsert block (where `media.upsertShow({...})` runs for each distinct show dir), after `seen.add(showId)`:

```ts
    seen.add(showId)
    if (!existedShow) added++
    bus?.emit({ kind: 'scan:detected', mediaKind: 'show', title: cleanTitle(showName), message: `Detected series "${cleanTitle(showName)}"` })
```

(Do NOT emit for episodes.)

- [ ] **Step 4: Track per-kind counts + pass bus through in `runScan`**

Track the three counts directly in the loops. Replace the two scan loops in `runScan` with this (it threads `deps.bus` into the path scanners and tallies per-kind counts):

```ts
  let movieCount = 0
  let showCount = 0
  let episodeCount = 0

  for (const p of scope.moviesPaths) {
    const r = await scanMoviesPath(p, cfg, deps.media, progress, deps.bus)
    for (const id of r.seen) seen.add(id)
    added += r.added
    failed += r.failed
    movieCount += r.seen.size
  }
  for (const p of scope.showsPaths) {
    const r = await scanShowsPath(p, cfg, deps.media, progress, deps.bus)
    for (const id of r.seen) seen.add(id)
    added += r.added
    failed += r.failed
    showCount += r.shows
    episodeCount += r.episodes
  }
```

This requires `scanShowsPath` to return `shows` + `episodes`. It already builds `showIdByDir` (a Map of distinct show dirs) and processes `epCands`. Change its return to:

```ts
  return { seen, added, failed, shows: showIdByDir.size, episodes: epCands.length }
```

and its signature return type to:

```ts
): Promise<{ seen: Set<string>; added: number; failed: number; shows: number; episodes: number }> {
```

Then the `runScan` return becomes:

```ts
  return {
    scope,
    itemsSeen: seen.size,
    itemsAdded: added,
    itemsRemoved: removed,
    itemsFailed: failed,
    durationMs: Date.now() - t0,
    movies: movieCount,
    shows: showCount,
    episodes: episodeCount,
  }
```

NOTE: `episodes` from `epCands.length` counts episode files discovered (a superset of those that probe successfully); that's acceptable for a "found" count. `movies` = movie rows seen.

- [ ] **Step 5: Emit scan:start / scan:progress / scan:done (manager.ts)**

In `apps/server/src/scanner/manager.ts`, the manager has the `deps.activityBus`? No — pass the bus via `ScanManagerDeps`. Add to `ScanManagerDeps`:

```ts
  /** Optional activity bus for live scan/metadata events. */
  bus?: ActivityBus
```

Add the import:

```ts
import type { ActivityBus } from '../activity/bus.ts'
```

In `executeOne`, emit `scan:start` after `running = {…}` is set, and make the progress sink emit throttled `scan:progress`. Replace the progress sink block:

```ts
    running = { trigger: p.trigger, scope: scopeLabel, startedAt, processed: 0, total: 0 }
    deps.bus?.emit({ kind: 'scan:start', trigger: p.trigger, scope: scopeLabel, message: `Scan started (${p.trigger}, ${scopeLabel})` })
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
```

Pass the bus into `runScan`: change the `runScan(scope, cfg, deps, progress)` call to include the bus in deps. The manager's `deps` (ScanManagerDeps) extends `ScanDeps`, so `deps` already has `media`/`collections`; add `bus`:

Find `result = await runScan(scope, cfg, deps, progress)` and change to:

```ts
      result = await runScan(scope, cfg, { media: deps.media, collections: deps.collections, bus: deps.bus }, progress)
```

After `running = null` (end of executeOne success path), emit `scan:done`:

```ts
    running = null
    deps.bus?.emit({
      kind: 'scan:done',
      movies: result.movies, shows: result.shows,
      added: result.itemsAdded, removed: result.itemsRemoved, failed: result.itemsFailed,
      durationMs: result.durationMs,
      message: `Scan done · ${result.movies} movies, ${result.shows} series (+${result.itemsAdded} −${result.itemsRemoved})`,
    })
```

NOTE: the catch-path `result` (error fallback) lacks the new count fields — update that fallback object to include `movies: 0, shows: 0, episodes: 0` so it satisfies `ScanResult`.

- [ ] **Step 6: Run to verify it passes**

Run: `npm -w @horizon/server exec vitest run test/scanner.integration.test.ts`
Expected: PASS, including existing tests. Then typecheck: `npm -w @horizon/server run typecheck` — fix any `ScanResult` construction sites flagged (the manager error fallback, any test building a ScanResult literal).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/scanner/scanner.ts apps/server/src/scanner/manager.ts apps/server/test/scanner.integration.test.ts
git commit -m "feat(scanner): emit scan:start/detected/progress/done activity events"
```

---

### Task 4: Metadata worker emits per-item steps

**Files:**
- Modify: `apps/server/src/metadata/refresh.ts`
- Test: `apps/server/test/metadata.refresh.test.ts` (create if it does not exist; otherwise add to it)

- [ ] **Step 1: Write the failing test**

Check for an existing refresh test: `ls apps/server/test | grep -i refresh`. If `metadata.refresh.test.ts` exists, add to it; else create it. Use fake `media` + `tmdb` + `changesCursor`. Minimal fakes:

```ts
import { describe, it, expect } from 'vitest'
import { createMetadataRefreshWorker, DEFAULT_REFRESH_CONFIG } from '../src/metadata/refresh.ts'

function fakeMedia(pick: any, internal: any) {
  return {
    findStaleMetadata: (() => { let done = false; return () => done ? [] : (done = true, [pick]) })(),
    getInternalRow: () => internal,
    upsertMovie: () => {},
    markMetadataFetched: () => {},
    markMetadataFailed: () => {},
  } as any
}

const baseInternal = {
  id: 'm1', filePath: '/x.mkv', title: 'Inception', year: 2010, durationSec: 1, resolution: '', videoCodec: '',
  container: '', hdr: { dv: false, hdr10: false, hdr10plus: false }, audioTracks: [], subtitleTracks: [],
  mtimeMs: 0, sizeBytes: 0, externalIds: {},
}

it('emits detected → searching → matched → fetching → fetched → stored for a searched movie', async () => {
  const pick = { id: 'm1', kind: 'movie', tmdbId: null, externalIds: {}, title: 'Inception', sortYear: 2010, parentId: null, season: null, episode: null, metadataFetchedAt: null, metadataFailedCount: 0 }
  const tmdb = {
    movieByTmdbId: async () => null, movieByImdbId: async () => null,
    searchMovie: async () => ({ kind: 'movie', tmdbId: 27205, title: 'Inception' }),
  } as any
  const events: any[] = []
  const bus = { emit: (e: any) => events.push(e), subscribe: () => () => {}, recent: () => [] }
  const worker = createMetadataRefreshWorker(DEFAULT_REFRESH_CONFIG, { media: fakeMedia(pick, baseInternal), tmdb, changesCursor: { get: () => null, set: () => {} } as any, bus })
  await worker.run({ useChangesFeed: false, drain: false })
  const steps = events.filter(e => e.kind === 'meta:item').map(e => e.step)
  expect(steps).toEqual(['detected', 'searching', 'matched', 'fetching', 'fetched', 'stored'])
})

it('emits failed(no-match) when nothing matches', async () => {
  const pick = { id: 'm1', kind: 'movie', tmdbId: null, externalIds: {}, title: 'Nope', sortYear: null, parentId: null, season: null, episode: null, metadataFetchedAt: null, metadataFailedCount: 0 }
  const tmdb = { movieByTmdbId: async () => null, movieByImdbId: async () => null, searchMovie: async () => null } as any
  const events: any[] = []
  const bus = { emit: (e: any) => events.push(e), subscribe: () => () => {}, recent: () => [] }
  const worker = createMetadataRefreshWorker(DEFAULT_REFRESH_CONFIG, { media: fakeMedia(pick, baseInternal), tmdb, changesCursor: { get: () => null, set: () => {} } as any, bus })
  await worker.run({ useChangesFeed: false, drain: false })
  const last = events.filter(e => e.kind === 'meta:item').pop()
  expect(last).toMatchObject({ step: 'failed', reason: 'no-match' })
})
```

If `DEFAULT_REFRESH_CONFIG`/the changesCursor shape differ, adapt to the real exports (check the top of `refresh.ts` and how existing tests build the worker).

- [ ] **Step 2: Run to verify it fails**

Run: `npm -w @horizon/server exec vitest run test/metadata.refresh.test.ts`
Expected: FAIL — no `meta:item` events emitted (bus unused).

- [ ] **Step 3: Add `bus` to deps + emit in `refreshOne` + run()**

In `apps/server/src/metadata/refresh.ts`:

Add the import:

```ts
import type { ActivityBus } from '../activity/bus.ts'
import type { MediaKind } from '@horizon/sdk'
```

Extend `MetadataRefreshDeps`:

```ts
export interface MetadataRefreshDeps {
  media: MediaRepo
  tmdb: TmdbProvider | null
  changesCursor: ChangesCursorRepo
  bus?: ActivityBus
}
```

Inside `createMetadataRefreshWorker`, after `const getConfig = …`, add a small helper:

```ts
  const bus = deps.bus
  function step(s: import('@horizon/sdk').MetaStep, kind: MediaKind, title: string, extra?: { tmdbId?: number; reason?: string }) {
    if (!bus) return
    const labels: Record<string, string> = {
      detected: `Detected ${kind} "${title}"`,
      'resolving-show': `Resolving show for "${title}"`,
      searching: `Searching TMDB for "${title}"`,
      matched: `Matched "${title}"${extra?.tmdbId ? ` #${extra.tmdbId}` : ''}`,
      fetching: `Fetching metadata for "${title}"`,
      fetched: `Fetched metadata for "${title}"`,
      stored: `Stored "${title}"`,
      failed: `Failed "${title}"${extra?.reason ? ` (${extra.reason})` : ''}`,
    }
    bus.emit({ kind: 'meta:item', step: s, mediaKind: kind, title, tmdbId: extra?.tmdbId, reason: extra?.reason, message: labels[s] })
  }
```

Rewrite the **movie branch** of `refreshOne` to emit steps (keep the existing logic; add emissions):

```ts
    if (pick.kind === 'movie') {
      step('detected', 'movie', pick.title)
      let m = pick.tmdbId ? await tmdb.movieByTmdbId(pick.tmdbId) : null
      if (!m && pick.externalIds.tmdb) m = await tmdb.movieByTmdbId(pick.externalIds.tmdb)
      if (!m && pick.externalIds.imdb) m = await tmdb.movieByImdbId(pick.externalIds.imdb)
      if (!m) { step('searching', 'movie', pick.title); m = await tmdb.searchMovie(pick.title, pick.sortYear ?? undefined) }
      if (!m) { step('failed', 'movie', pick.title, { reason: 'no-match' }); deps.media.markMetadataFailed(pick.id, now); return false }
      step('matched', 'movie', pick.title, { tmdbId: m.tmdbId })
      step('fetching', 'movie', pick.title, { tmdbId: m.tmdbId })

      const existing = deps.media.getInternalRow(pick.id)
      if (!existing || !existing.filePath) {
        step('failed', 'movie', pick.title, { reason: 'no-file' })
        deps.media.markMetadataFailed(pick.id, now)
        return false
      }
      step('fetched', 'movie', pick.title, { tmdbId: m.tmdbId })
      deps.media.upsertMovie({
        id: existing.id, filePath: existing.filePath, title: existing.title, sortYear: existing.year,
        durationSec: existing.durationSec ?? 0, resolution: existing.resolution ?? '', videoCodec: existing.videoCodec ?? '',
        container: existing.container ?? '', hdr: existing.hdr ?? { dv: false, hdr10: false, hdr10plus: false },
        audioTracks: existing.audioTracks ?? [], subtitleTracks: existing.subtitleTracks ?? [],
        mtimeMs: existing.mtimeMs ?? 0, sizeBytes: existing.sizeBytes ?? 0,
        externalIds: existing.externalIds, metadata: m,
      })
      deps.media.markMetadataFetched(pick.id, m.tmdbId ?? null, now)
      step('stored', 'movie', pick.title, { tmdbId: m.tmdbId })
      return true
    }
```

Apply the SAME pattern to the **show branch** (`detected`/`searching`/`matched`/`fetching`/`fetched`/`stored`/`failed`, `mediaKind: 'show'`), reusing its existing tmdbId/tvdb/search fallbacks; emit `searching` only before `tmdb.searchShow`.

Apply to the **episode branch** with an extra `resolving-show` step: emit `step('detected', 'episode', pick.title)`, then `step('resolving-show', 'episode', pick.title)` before resolving `showTmdbId`; on missing show id → `step('failed','episode',pick.title,{reason:'no-show'})`; then `matched`(use showTmdbId), `fetching`, on null ep → `failed(no-match)`, else `fetched` → upsert → `stored`.

In the main `run()` method: emit `meta:start` once if there is work, and `meta:done` in the `finally`. Right before the `for (const pick of work)` loop add:

```ts
        if (work.length > 0) bus?.emit({ kind: 'meta:start', message: 'Metadata refresh started' })
```

In the `finally` block, after computing `result`, add:

```ts
        bus?.emit({ kind: 'meta:done', refreshed, failed, durationMs: result.durationMs, message: `Metadata refresh done · ${refreshed} ok, ${failed} failed` })
```

(If `result` is built inside `finally`, emit using the same `refreshed`/`failed`/`Date.now()-t0` values.)

- [ ] **Step 4: Run to verify it passes**

Run: `npm -w @horizon/server exec vitest run test/metadata.refresh.test.ts`
Expected: PASS (both step-sequence tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm -w @horizon/server run typecheck`
Expected: clean.

```bash
git add apps/server/src/metadata/refresh.ts apps/server/test/metadata.refresh.test.ts
git commit -m "feat(metadata): emit per-item refresh steps to activity bus"
```

---

### Task 5: Wire the bus through server construction

**Files:**
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: Add `activityBus` to `ScanWorkers`**

In `apps/server/src/server.ts`, extend the interface + import:

```ts
import type { ActivityBus } from './activity/bus.ts'
```

```ts
export interface ScanWorkers {
  scanManager: ScanManager
  refreshWorker: MetadataRefreshWorker
  scanHistory: ScanHistoryRepo
  activityBus: ActivityBus
}
```

- [ ] **Step 2: Create the bus and inject it (index.ts)**

In `apps/server/src/index.ts`, add the import:

```ts
import { createActivityBus } from './activity/bus.ts'
```

Before `createMetadataRefreshWorker(...)`, create the bus:

```ts
  const activityBus = createActivityBus()
```

Add `bus: activityBus` to the metadata worker deps object:

```ts
    { media: mediaRepo, tmdb: initialTmdb, changesCursor: changesCursorRepo, bus: activityBus },
```

Add `bus: activityBus` to the `createScanManager(cfg, { … })` deps object.

Add `activityBus` to the `ScanWorkers` passed to `buildServer`:

```ts
    { scanManager, refreshWorker, scanHistory: scanHistoryRepo, activityBus },
```

- [ ] **Step 3: Typecheck**

Run: `npm -w @horizon/server run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/server.ts apps/server/src/index.ts
git commit -m "feat(server): construct + inject activity bus into scan workers"
```

---

### Task 6: SSE stream route

**Files:**
- Modify: `apps/server/src/routes/library.ts`
- Test: `apps/server/test/routes.activity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/routes.activity.test.ts`, modeled on `apps/server/test/routes.collections.test.ts` / `routes.browse.test.ts` (build a Fastify app, register library routes with fake workers incl. an `activityBus` that has `recent()` returning a seeded event). Assert auth + replay:

```ts
import { describe, it, expect } from 'vitest'
// buildApp helper as in routes.collections.test.ts, but ScanWorkers includes:
//   activityBus: { recent: () => [{ seq: 0, ts: 1, kind: 'meta:start', message: 'x' }], subscribe: () => () => {}, emit: () => {} }

describe('GET /library/activity/stream', () => {
  it('rejects members', async () => {
    const res = await app.inject({ method: 'GET', url: '/library/activity/stream', headers: memberHeaders })
    expect(res.statusCode).toBe(403)
  })

  it('replays recent events as SSE frames for owner', async () => {
    const res = await app.inject({ method: 'GET', url: '/library/activity/stream', headers: ownerHeaders, payloadAsStream: false })
    // inject does not stream forever because we close after replay in test mode;
    // assert the replayed frame is present and content-type is event-stream.
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.body).toContain('"kind":"meta:start"')
  })
})
```

NOTE on testing SSE with `app.inject`: a never-ending stream would hang `inject`. To keep the handler testable, the route writes the replay frames synchronously, then — only when there are **no** further writes expected in a unit context — relies on the client closing. For the test, register the route with the fake bus whose `subscribe` returns a no-op and emits nothing, and call `reply.raw.end()` is NOT done in prod. Instead, make the test assert via a direct call to a small exported helper. **Simpler, chosen approach:** extract the replay-string building into a pure exported function and unit-test that, plus a lightweight inject test that only checks the 403 path (which returns normally). See Step 3.

- [ ] **Step 2: Run to verify it fails**

Run: `npm -w @horizon/server exec vitest run test/routes.activity.test.ts`
Expected: FAIL — route not registered (404, not 403).

- [ ] **Step 3: Implement the route + a testable replay helper**

In `apps/server/src/routes/library.ts`, add the SSE route inside `registerLibrary`. Add imports at the top of the file:

```ts
import type { ActivityEvent } from '@horizon/sdk'
```

Add an exported helper (above `registerLibrary`) so the frame format is unit-testable:

```ts
/** Serialize one activity event as an SSE `data:` frame. */
export function sseFrame(evt: ActivityEvent): string {
  return `data: ${JSON.stringify(evt)}\n\n`
}
```

Add the route (owner/admin only):

```ts
  app.get('/library/activity/stream', async (req, reply) => {
    const caller = resolveCallerRole(req)
    if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Authentication required')
    if (caller.role === 'member') {
      return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Only owner or admin can view activity')
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    reply.hijack()

    // Replay the ring buffer, then stream live.
    for (const evt of workers.activityBus.recent()) reply.raw.write(sseFrame(evt))
    const unsub = workers.activityBus.subscribe(evt => reply.raw.write(sseFrame(evt)))
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15_000)

    req.raw.on('close', () => { clearInterval(ping); unsub() })
  })
```

- [ ] **Step 4: Adjust the test to the chosen approach**

Replace the hanging inject test with: (a) a `sseFrame` unit test, and (b) the 403 inject test:

```ts
import { sseFrame } from '../src/routes/library.ts'

it('sseFrame serializes an event', () => {
  expect(sseFrame({ seq: 1, ts: 2, kind: 'meta:start', message: 'x' } as any)).toBe('data: {"seq":1,"ts":2,"kind":"meta:start","message":"x"}\n\n')
})

it('rejects members', async () => {
  const res = await app.inject({ method: 'GET', url: '/library/activity/stream', headers: memberHeaders })
  expect(res.statusCode).toBe(403)
})
```

(Do not inject the owner path — it hijacks and streams, which would hang `inject`. The owner path is covered by the manual smoke test at the end.)

- [ ] **Step 5: Run to verify it passes**

Run: `npm -w @horizon/server exec vitest run test/routes.activity.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/library.ts apps/server/test/routes.activity.test.ts
git commit -m "feat(api): SSE GET /library/activity/stream (owner/admin)"
```

---

### Task 7: Web activity stream hook + reducer

**Files:**
- Create: `apps/web/src/hooks/useActivityStream.ts`
- Test: web reducer test (see runner note)

- [ ] **Step 1: Determine the web test runner**

Run: `grep -n '"test"' apps/web/package.json || echo "no web test script"`
If a vitest script exists, put the test at `apps/web/test/activityReducer.test.ts` matching its config. If NO web test runner exists, place the pure reducer + test in the SDK instead: create `libs/sdk/src/activityReducer.ts` (pure, no React) and `libs/sdk/test/activityReducer.test.ts`, and have the hook import the reducer from `@horizon/sdk`. **Default to the SDK location** (sdk has a vitest runner; web may not), so the reducer is guaranteed unit-tested.

- [ ] **Step 2: Write the failing reducer test**

Create `libs/sdk/test/activityReducer.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { activityReducer, initialActivityState } from '../src/activityReducer.ts'
import type { ActivityEvent } from '../src/activity.ts'

const ev = (e: Partial<ActivityEvent>): ActivityEvent => ({ seq: 0, ts: 0, message: 'm', ...(e as any) })

describe('activityReducer', () => {
  it('tracks scan phase + counts from detected, finalizes on done', () => {
    let s = initialActivityState
    s = activityReducer(s, ev({ kind: 'scan:start', trigger: 'manual', scope: 'full' }))
    expect(s.phase).toBe('scanning')
    s = activityReducer(s, ev({ kind: 'scan:detected', mediaKind: 'movie', title: 'A' }))
    s = activityReducer(s, ev({ kind: 'scan:detected', mediaKind: 'show', title: 'B' }))
    expect(s.counts).toEqual({ movies: 1, shows: 1, episodes: 0 })
    s = activityReducer(s, ev({ kind: 'scan:done', movies: 10, shows: 3, added: 1, removed: 0, failed: 0, durationMs: 5 }))
    expect(s.counts).toMatchObject({ movies: 10, shows: 3 })
    expect(s.progress).toBeNull()
  })

  it('tracks current metadata step and resets on meta:done', () => {
    let s = activityReducer(initialActivityState, ev({ kind: 'meta:start' }))
    expect(s.phase).toBe('metadata')
    s = activityReducer(s, ev({ kind: 'meta:item', step: 'fetching', mediaKind: 'movie', title: 'A', tmdbId: 7 }))
    expect(s.current).toMatchObject({ step: 'fetching', title: 'A', tmdbId: 7 })
    s = activityReducer(s, ev({ kind: 'meta:done', refreshed: 1, failed: 0, durationMs: 1 }))
    expect(s.phase).toBe('idle')
    expect(s.current).toBeNull()
  })

  it('caps rawLines at 500', () => {
    let s = initialActivityState
    for (let i = 0; i < 600; i++) s = activityReducer(s, ev({ kind: 'error', code: 'x', message: `e${i}` }))
    expect(s.rawLines.length).toBe(500)
    expect(s.rawLines[s.rawLines.length - 1]).toContain('e599')
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm -w @horizon/sdk exec vitest run test/activityReducer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the reducer (SDK)**

Create `libs/sdk/src/activityReducer.ts`:

```ts
import type { ActivityEvent, MediaKind, MetaStep } from './activity.ts'

export interface ActivityState {
  phase: 'idle' | 'scanning' | 'metadata'
  counts: { movies: number; shows: number; episodes: number }
  progress: { processed: number; total: number } | null
  current: { step: MetaStep; mediaKind: MediaKind; title: string; tmdbId?: number } | null
  rawLines: string[]
}

export const initialActivityState: ActivityState = {
  phase: 'idle',
  counts: { movies: 0, shows: 0, episodes: 0 },
  progress: null,
  current: null,
  rawLines: [],
}

const MAX_LINES = 500

function fmtTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function activityReducer(state: ActivityState, evt: ActivityEvent): ActivityState {
  const line = `[${fmtTime(evt.ts)}] ${evt.message}`
  const rawLines = [...state.rawLines, line]
  if (rawLines.length > MAX_LINES) rawLines.splice(0, rawLines.length - MAX_LINES)
  const next: ActivityState = { ...state, rawLines }

  switch (evt.kind) {
    case 'scan:start':
      return { ...next, phase: 'scanning', counts: { movies: 0, shows: 0, episodes: 0 }, progress: null }
    case 'scan:detected':
      return {
        ...next,
        counts: {
          movies: next.counts.movies + (evt.mediaKind === 'movie' ? 1 : 0),
          shows: next.counts.shows + (evt.mediaKind === 'show' ? 1 : 0),
          episodes: next.counts.episodes + (evt.mediaKind === 'episode' ? 1 : 0),
        },
      }
    case 'scan:progress':
      return { ...next, progress: { processed: evt.processed, total: evt.total } }
    case 'scan:done':
      return { ...next, counts: { movies: evt.movies, shows: evt.shows, episodes: next.counts.episodes }, progress: null, phase: 'idle' }
    case 'meta:start':
      return { ...next, phase: 'metadata' }
    case 'meta:item':
      return { ...next, current: { step: evt.step, mediaKind: evt.mediaKind, title: evt.title, tmdbId: evt.tmdbId } }
    case 'meta:done':
      return { ...next, phase: 'idle', current: null }
    case 'error':
      return next
    default:
      return next
  }
}
```

Export from the barrel: in `libs/sdk/src/index.ts` add `export * from './activityReducer.ts'`.

- [ ] **Step 5: Run to verify it passes**

Run: `npm -w @horizon/sdk exec vitest run test/activityReducer.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Implement the React hook**

Create `apps/web/src/hooks/useActivityStream.ts`:

```ts
import { useEffect, useReducer } from 'react'
import { activityReducer, initialActivityState, ACTIVITY_STREAM_PATH } from '@horizon/sdk'
import type { ActivityEvent } from '@horizon/sdk'

/** Subscribe to the server activity SSE stream. Returns the folded live state.
 *  `enabled` lets callers open the stream only while the panel is mounted. */
export function useActivityStream(enabled = true) {
  const [state, dispatch] = useReducer(activityReducer, initialActivityState)

  useEffect(() => {
    if (!enabled) return
    const es = new EventSource(ACTIVITY_STREAM_PATH, { withCredentials: true })
    es.onmessage = (e) => {
      try { dispatch(JSON.parse(e.data) as ActivityEvent) } catch { /* ignore malformed frame */ }
    }
    // EventSource auto-reconnects on error; nothing to do here but keep it open.
    return () => es.close()
  }, [enabled])

  return state
}
```

- [ ] **Step 7: Typecheck**

Run: `npm -w @horizon/sdk run build && npm -w @horizon/web run build`
Expected: compiles (web build = tsc + vite).

- [ ] **Step 8: Commit**

```bash
git add libs/sdk/src/activityReducer.ts libs/sdk/src/index.ts libs/sdk/test/activityReducer.test.ts apps/web/src/hooks/useActivityStream.ts
git commit -m "feat(web): activity stream hook + pure reducer"
```

---

### Task 8: Expanded badge + raw log panel

**Files:**
- Create: `apps/web/src/components/ActivityLogPanel.tsx`
- Create: `apps/web/src/components/ActivityLogPanel.css`
- Modify: `apps/web/src/pages/Settings.tsx`

- [ ] **Step 1: Create the raw log panel**

Create `apps/web/src/components/ActivityLogPanel.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react'
import './ActivityLogPanel.css'

/** Live raw activity log. Auto-scrolls to the bottom unless the user scrolls up. */
export default function ActivityLogPanel({ lines }: { lines: string[] }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [stick, setStick] = useState(true)

  useEffect(() => {
    if (stick && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [lines, stick])

  function onScroll() {
    const el = boxRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    setStick(atBottom)
  }

  return (
    <div className="actlog">
      <div className="actlog__head">
        <span className={`actlog__dot ${stick ? 'is-live' : ''}`} />
        <span>{stick ? 'Live' : 'Paused (scroll to bottom to resume)'}</span>
        <span className="actlog__count">{lines.length} lines</span>
      </div>
      <div className="actlog__body" ref={boxRef} onScroll={onScroll}>
        {lines.length === 0
          ? <div className="actlog__empty">No activity yet.</div>
          : lines.map((l, i) => <div className="actlog__line" key={i}>{l}</div>)}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create its CSS**

Create `apps/web/src/components/ActivityLogPanel.css`:

```css
.actlog { margin-top: 10px; border: 1px solid var(--border, #2a2a2a); border-radius: 8px; overflow: hidden; }
.actlog__head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: 12px; background: var(--surface, #1a1a1a); }
.actlog__dot { width: 8px; height: 8px; border-radius: 50%; background: #666; }
.actlog__dot.is-live { background: #3ad29f; }
.actlog__count { margin-left: auto; opacity: 0.6; }
.actlog__body { max-height: 220px; overflow-y: auto; padding: 8px 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; background: #0d0d0d; }
.actlog__line { white-space: pre-wrap; word-break: break-word; }
.actlog__empty { opacity: 0.5; }
```

- [ ] **Step 3: Wire into `ScanStatusBadge`**

In `apps/web/src/pages/Settings.tsx`:

Add imports near the top:

```tsx
import { useActivityStream } from '../hooks/useActivityStream.ts'
import ActivityLogPanel from '../components/ActivityLogPanel.tsx'
```

Inside `ScanStatusBadge`, after the existing `const [busy, setBusy] = useState(false)`:

```tsx
  const [showLog, setShowLog] = useState(false)
  const activity = useActivityStream(true)
```

After the existing `detail` computation, build a live line from the activity stream. Replace the component's returned JSX's trailing `</div>` block by inserting, after the progress-bar `{showBar && (…)}`:

```tsx
      {active && (
        <div className="settings__scan-live">
          <span>Movies: {activity.counts.movies} · Series: {activity.counts.shows}</span>
          {activity.current && (
            <span className="settings__scan-current">
              {' · '}{activity.current.step} — “{activity.current.title}”
              {activity.current.tmdbId ? ` #${activity.current.tmdbId}` : ''}
            </span>
          )}
        </div>
      )}
      <button type="button" className="settings__scan-logtoggle" onClick={() => setShowLog(v => !v)}>
        {showLog ? 'Hide raw log' : 'Show raw log'}
      </button>
      {showLog && <ActivityLogPanel lines={activity.rawLines} />}
```

Add minimal CSS for the new bits to the existing scan styles (find `.settings__scan-bar` in the relevant CSS file — likely `apps/web/src/pages/Settings.css`; grep for `settings__scan-bar` to locate it) and append:

```css
.settings__scan-live { font-size: 12px; opacity: 0.85; margin-top: 6px; }
.settings__scan-current { opacity: 0.7; }
.settings__scan-logtoggle { margin-top: 8px; background: none; border: 1px solid var(--border, #2a2a2a); border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; color: inherit; }
```

- [ ] **Step 4: Typecheck + build**

Run: `npm -w @horizon/web run build`
Expected: compiles, no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ActivityLogPanel.tsx apps/web/src/components/ActivityLogPanel.css apps/web/src/pages/Settings.tsx apps/web/src/pages/Settings.css
git commit -m "feat(web): live scan activity view + raw log panel in scan badge"
```

---

## Final verification

- [ ] **Run the whole suite + builds**

Run: `npm -w @horizon/server run typecheck && npm test && npm -w @horizon/web run build`
Expected: server typecheck clean; server + sdk tests pass; web build clean.

- [ ] **Manual smoke (via /run or browse)**
  - Open Settings → Server as owner, click "Rescan now".
  - Badge shows live "Movies: X · Series: Y" and the current metadata step line.
  - Toggle "Show raw log" → panel streams `Detected … → Searching … → Matched #… → Fetching … → Fetched … → Stored …` lines, auto-scrolling.
  - Confirm a member account gets 403 on `/api/library/activity/stream` (e.g. via curl with a member cookie).
```
