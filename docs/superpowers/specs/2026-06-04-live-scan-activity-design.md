# Live scan & metadata activity feed

Date: 2026-06-04
Status: Approved (design)

Extend the scan status from a 5-second polled snapshot into a real-time activity
feed: live phase + per-kind counts during the file scan, a per-item step sequence
during metadata enrichment, and a toggleable raw-output log panel. Owner/admin
only.

---

## Goals

- See the scan phase and live counts: "Scanning… Movies: X · Series: Y".
- See which item metadata is being fetched for, with steps:
  `detected → searching* → matched → fetching → fetched → stored` (or `failed`).
  (`searching` only when no prior id; episodes add `resolving show` before
  `matched`.)
- A "Show raw log" toggle that opens a live panel of the raw event stream.

## Non-goals (YAGNI)

- No DB persistence of activity (live-only, in-memory ring buffer).
- No bidirectional control (pause/verbosity) — SSE one-way is enough.
- No image-download steps (images are fetched lazily by the image proxy, not
  during refresh).

---

## Architecture

A single in-process **activity bus** that the scan manager, the scanner's
`runScan`, and the metadata refresh worker all emit to. The web subscribes over
**SSE**. One-way stream; the panel only displays.

```
runScan / scanManager / refreshWorker  ──emit──▶  ActivityBus (ring buffer + subscribers)
                                                        │
                                          GET /library/activity/stream (SSE, owner/admin)
                                                        │
                                          useActivityStream (EventSource + reducer)
                                                        │
                                          ScanStatusBadge (live view + raw log panel)
```

### Why SSE, not WebSocket

Traffic is one-directional (server→client). `EventSource` gives auto-reconnect
and cookie auth for free; the server side is `reply.raw.write('data: …\n\n')`.
WebSocket would add framing/heartbeat/reconnect/client-set code for an unused
bidirectional channel. Resource use is identical (one idle connection per
viewer; viewers ≈ 1 admin). Decided: SSE.

---

## Server

### Activity bus — `apps/server/src/activity/bus.ts`

In-memory. No external deps.

```ts
export interface ActivityBus {
  emit(evt: ActivityEventInput): void          // stamps seq + ts, buffers, fans out
  subscribe(fn: (evt: ActivityEvent) => void): () => void   // returns unsubscribe
  recent(): ActivityEvent[]                     // current ring-buffer contents (oldest→newest)
}
export function createActivityBus(opts?: { bufferSize?: number }): ActivityBus
```

- Ring buffer default size **500**; oldest dropped on overflow.
- `emit` assigns a monotonic `seq` (incrementing integer) and `ts` (ms). The
  caller passes the event without `seq`/`ts` (`ActivityEventInput`).
- `subscribe` adds to a `Set<fn>`; a subscriber that throws is caught and
  removed (never let one bad subscriber break emit).
- `recent()` returns a shallow copy of the buffer for replay-on-connect.

The bus uses the real clock and a counter. To stay testable, `createActivityBus`
accepts an optional `now: () => number` (defaults to `Date.now`).

### Event model — `libs/sdk/src/activity.ts` (shared server + web)

```ts
export type MediaKind = 'movie' | 'show' | 'episode'

export type MetaStep =
  | 'detected' | 'resolving-show' | 'searching' | 'matched'
  | 'fetching' | 'fetched' | 'stored' | 'failed'

export type ActivityEvent =
  | { seq: number; ts: number; kind: 'scan:start'; trigger: string; scope: string; message: string }
  | { seq: number; ts: number; kind: 'scan:progress'; processed: number; total: number; movies: number; shows: number; episodes: number; message: string }
  | { seq: number; ts: number; kind: 'scan:detected'; mediaKind: MediaKind; title: string; message: string }
  | { seq: number; ts: number; kind: 'scan:done'; movies: number; shows: number; added: number; removed: number; failed: number; durationMs: number; message: string }
  | { seq: number; ts: number; kind: 'meta:start'; message: string }
  | { seq: number; ts: number; kind: 'meta:item'; step: MetaStep; mediaKind: MediaKind; title: string; tmdbId?: number; reason?: string; cached?: boolean; message: string }
  | { seq: number; ts: number; kind: 'meta:done'; refreshed: number; failed: number; durationMs: number; message: string }
  | { seq: number; ts: number; kind: 'error'; code: string; message: string }

export type ActivityEventInput = /* same union minus seq + ts */
```

Every event carries a preformatted `message` (the line shown in the raw panel)
plus structured fields (for the live summary view). Building `message` on the
server keeps the raw log consistent and lets the client stay dumb.

### Emission points

**Scanner** (`apps/server/src/scanner/scanner.ts`): `runScan` gains an optional
`bus?: ActivityBus` (via `ScanDeps`). Track per-kind tallies as items are
upserted:
- On a newly upserted item (the `!existed` branches already present for movies,
  shows, episodes): `bus.emit({ kind: 'scan:detected', mediaKind, title })`.
- Maintain running `{ movies, shows, episodes }` counts; emit
  `scan:progress` from the progress sink, **throttled to ≤5/sec** (see manager).

**Scan manager** (`apps/server/src/scanner/manager.ts`): in `executeOne`:
- Emit `scan:start` at the top (trigger + scope).
- Emit `scan:done` after `running = null`, from the `ScanResult` + final counts
  (the manager reads final counts from the `ScanResult`, which `runScan` extends
  to carry `{ movies, shows, episodes }`).

**Ownership split:** `runScan` owns per-kind counts and emits `scan:detected`
(per new item) and `scan:progress` (it alone knows the running tallies); the
manager owns `scan:start` and `scan:done`. `scan:progress` is throttled inside
`runScan` — emit only if ≥200ms since the last `scan:progress` (≤5/sec) — so a
fast scan can't flood the stream. The existing `progress` sink
(`tick`/`addTotal`) continues to mutate the `running` snapshot unchanged for the
polled status; the new emission is additive.

**Metadata worker** (`apps/server/src/metadata/refresh.ts`): `refreshOne` gains
emission at each boundary. Worker gains an optional `bus` dep.
- `meta:start` once per `run()` that has work.
- Per item, in order:
  - `detected` (title from the internal row).
  - episodes only: `resolving-show` before matching.
  - `searching` only when the item has no tmdbId/imdbId/tvdbId and we fall back
    to title search.
  - `matched` with the resolved `tmdbId` (and matched title in `message`).
  - `fetching`, then `fetched` (`cached: true` when the tmdb disk cache served
    it — the client/provider can signal this; if not cheaply available, omit
    `cached`).
  - `stored` on successful upsert+mark, OR `failed` with `reason`
    (`no-match` | `tmdb-error`) — terminal.
- `meta:done` at end of `run()` with refreshed/failed/durationMs.
- Existing sticky `errorState` (TMDB connectivity) additionally emits an
  `error` event.

Emission must never break the pipeline: wrap nothing special — the bus already
guards subscribers; `emit` itself does not throw.

### SSE route — `GET /library/activity/stream`

Add to `apps/server/src/routes/library.ts` (owner/admin via `resolveCallerRole`;
members/anon get 403/401). Implementation:
- Reject non-owner/admin before upgrading.
- Set headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
  `Connection: keep-alive`, `X-Accel-Buffering: no`.
- Write the ring buffer first (replay): for each `recent()` event,
  `reply.raw.write('data: ' + JSON.stringify(evt) + '\n\n')`.
- `subscribe` to the bus; each event → write `data:` frame.
- Keep-alive: `setInterval` writing a comment line `: ping\n\n` every 15s.
- On `req.raw.on('close')`: clear the interval and unsubscribe.
- Use `reply.hijack()` (Fastify) so Fastify doesn't try to send its own
  response.

Wiring: the bus is created in `apps/server/src/index.ts`, injected into
`scanManager` (deps), `refreshWorker` (deps), and exposed on `ScanWorkers` (so
the route can reach it). `ScanWorkers` gains `activityBus: ActivityBus`.

---

## SDK

`libs/sdk/src/activity.ts`: the `ActivityEvent` union + `MetaStep`/`MediaKind`,
re-exported from the barrel. The web builds the EventSource URL directly
(`/api/library/activity/stream`); no client method needed (EventSource isn't a
`fetch`). Optionally export a constant `ACTIVITY_STREAM_PATH`.

---

## Web

### `useActivityStream` hook — `apps/web/src/hooks/useActivityStream.ts`

- Opens `new EventSource('/api/library/activity/stream', { withCredentials: true })`.
- A **pure reducer** `activityReducer(state, evt)` folds events into:

```ts
interface ActivityState {
  phase: 'idle' | 'scanning' | 'metadata'
  counts: { movies: number; shows: number; episodes: number }
  progress: { processed: number; total: number } | null
  current: { step: MetaStep; mediaKind: MediaKind; title: string; tmdbId?: number } | null
  rawLines: string[]   // capped at 500, formatted `[hh:mm:ss] message`
}
```

  - `scan:start` → phase scanning, reset counts.
  - `scan:progress` → counts + progress.
  - `scan:done` → counts final, progress null.
  - `meta:start` → phase metadata.
  - `meta:item` → current = {step, …}; on `stored`/`failed` keep showing briefly.
  - `meta:done` → phase idle, current null.
  - every event → push formatted line to `rawLines` (drop oldest past 500).
- EventSource auto-reconnects; on reconnect the server replays the buffer
  (duplicate seqs possible — the reducer is idempotent enough for display;
  `rawLines` may show a small replayed tail, acceptable).
- Cleanup closes the EventSource on unmount.

Keeping the reducer pure + exported makes it unit-testable without a browser.

### ScanStatusBadge (extend — `apps/web/src/pages/Settings.tsx`)

- Keep the existing 5s poll for the **idle/last-scan summary** (last result, time
  ago) — the stream is silent when nothing runs.
- Layer `useActivityStream` for the **live** view. While `phase !== 'idle'`:
  - phase label + existing progress bar (`processed/total`).
  - `Movies: {counts.movies} · Series: {counts.shows}` (episodes optional).
  - current-item line: e.g. `Fetching — "Harry Potter…" #671` driven by
    `current.step` + `title` + `tmdbId`.
- **`Show raw log`** toggle → collapsible monospace panel:
  - renders `rawLines`, auto-scrolls to bottom.
  - pause auto-scroll when the user scrolls up; resume when back at bottom.
  - small header: live dot + line count + a "clear" (clears local `rawLines`).
- New component `apps/web/src/components/ActivityLogPanel.tsx` for the panel +
  its CSS, to keep Settings.tsx from growing further.

---

## Error handling

- TMDB/connectivity failures: existing sticky `errorState` stays; also emitted as
  `error` events and surfaced in the badge.
- SSE: unsubscribe + clear ping on socket close (no leaked subscribers/timers);
  15s keep-alive prevents proxy idle timeout; ring buffer bounds memory;
  `scan:progress` throttled (≤5/s) so a fast scan can't flood the stream.
- A subscriber callback that throws is caught and dropped by the bus.

---

## Testing

**Server**
- Bus unit: seq monotonic + ts stamped; ring-buffer cap drops oldest;
  subscribe receives subsequent emits; unsubscribe stops delivery; a throwing
  subscriber is removed and doesn't break `emit`; `recent()` returns buffered
  order.
- Scanner integration: a scan emits `scan:detected` per new item and a
  `scan:done` with correct movies/shows counts (capture via a test bus
  subscriber).
- Metadata worker unit (fake tmdb + media): for a movie with a known id → steps
  `detected, matched, fetching, fetched, stored`; for a movie needing search →
  includes `searching`; for a no-match → `…, searching, failed(no-match)`; for an
  episode → includes `resolving-show`.
- SSE route: a request as a member → 403; as owner, the handler writes the
  replay frames for `recent()` (assert `data:` lines on a fake `reply.raw`).

**Web**
- `activityReducer` pure unit: scan phase + counts from `scan:progress`;
  metadata `current` transitions across steps; `rawLines` cap at 500; `meta:done`
  resets to idle.

---

## Out of scope

- Persisting activity history / a searchable past-runs log.
- Controls sent back over the channel (pause, verbosity).
- Per-image download progress.
