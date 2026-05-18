# CONTEXT — Horizon domain language

Living glossary for Horizon. Add terms here when grilling sessions sharpen a
concept, when a deepened module is named after a concept that didn't exist
before, or when a term shows up in two files and means subtly different things.

This file is the authority — code, comments, and chat should track its
vocabulary. If a term here is wrong, fix it here first.

---

## Identity

### Role
Every User row carries a `role` of `owner`, `admin`, or `member` (default
`member`). Exactly one owner exists per database, enforced by a partial unique
index (`idx_users_one_owner`) on `users.role WHERE role='owner'`. The owner is
auto-elected at first profile creation (`POST /users` on an empty DB) or
backfilled to the oldest existing user during the v3 migration. The owner's
role is immutable — `PATCH /users/:id` with a different role rejects with
`role-immutable` (403). The owner row cannot be deleted — `DELETE /users/:id`
rejects with `owner-protected` (403). The web UI hides the "Delete profile"
button in the badge menu when the active user is the owner. See
[apps/server/src/repos/users.ts](apps/server/src/repos/users.ts).

## Library

### MediaItem
A single playable artifact, in the wire/domain shape. `kind` is one of
`movie | show | episode`. Returned by every `MediaRepo.get*` / `list*` /
`getByTmdbId` method that wasn't explicitly named for internal use.
NO `filePath`, NO DB bookkeeping (firstSeenAt/lastSeenAt/deletedAt/mtimeMs/
sizeBytes), NO metadata-refresh state (tmdbId, metadataFetched*, etc) — those
live on MediaItemRow. Wire-safe by construction; routes can serialize
MediaItem directly without leaking server internals. See
[apps/server/src/repos/media.ts](apps/server/src/repos/media.ts).

### MediaItemRow
Full DB row — MediaItem plus filesystem (`filePath`, `mtimeMs`, `sizeBytes`)
and bookkeeping (`firstSeenAt`, `lastSeenAt`, `deletedAt`, `tmdbId`,
`metadataFetchedAt`, `metadataFailedAt`, `metadataFailedCount`). Returned by
`MediaRepo.getInternal(id)` and `getByTmdbId(tmdbId)`. Internal callers only
(PlaybackOrchestrator for filePath, MetadataRefreshWorker for bookkeeping).
NEVER serialize this to the wire.

### Collection
A named grouping of MediaItems (currently movies only). Detected during a Scan
from on-disk folder structure; replaced wholesale per scan. See
[server/src/repos/collections.ts](server/src/repos/collections.ts).

### Scan
The pipeline that walks `HORIZON_MOVIES_ROOT` / `HORIZON_SHOWS_ROOT`, probes
files with ffprobe, derives IDs, and upserts MediaItems. Triggered on boot,
nightly via the Scheduler, by manual API call, or by the optional Watcher.

### MetadataRefresh
The worker that backfills TMDB metadata onto MediaItems whose enrichment is
stale, missing, or invalidated by the TMDB changes feed. Independent of Scan
— a Scan never blocks on the network. See
[server/src/metadata/refresh.ts](server/src/metadata/refresh.ts).

### Scenario (test fixture)
A named deterministic mock dataset (`empty`, `tiny`, `default`, `huge`,
`mixed-quality`, `collections-heavy`) that wipes and reseeds the DB. Used by
the CLI seed script, the dev-only `POST /dev/seed/:scenario` route, and e2e
tests. See [server/src/seed/scenarios.ts](server/src/seed/scenarios.ts).

## Playback

### Session
A single client's streaming context: which MediaItem, the chosen playback
method, the ffmpeg child process (if any), the on-disk session dir holding
HLS segments, the WS socket, and lifecycle state. See
[server/src/session/types.ts](server/src/session/types.ts).

### SessionState
`pre-buffer | active | detached | parked | destroyed`. Transitions are driven
by WS attach, WS close (grace timer), explicit DELETE, and session destroy.

### ProbeView
The subset of a MediaItem that the playback decision needs: duration,
resolution, codecs, HDR flags, audio/subtitle tracks, container. Built by the
PlaybackOrchestrator from a MediaItem so the rest of playback never sees the
DB-row-shaped MediaItem.

### PlaybackPlan
The answer to "what would we encode this as" for a single Session: `{ method,
needsToneMap, toneMap, renditions, audioTrackIndex, audioStrategy,
videoStrategy }`. Built by `buildPlan(probe, capabilities, hwAccel, ...)` at
session create; rebuilt via `planWithProfile` / `planWithAudioTrack` when the
user picks a new profile or audio track. Stable across seeks + segment-driven
restarts. See [apps/server/src/transcode/plan.ts](apps/server/src/transcode/plan.ts).

### RenderContext
Per-spawn runtime context for ffmpeg arg rendering: `{ sourceFilePath,
sessionDir, startSegment, seekPositionMs }`. Built fresh each spawn by the
restart actuator (or the orchestrator on first spawn). The Renderer
(`transcode/render.ts`) consumes a PlaybackPlan + RenderContext + HwAccel and
emits ffmpeg argv. Pure function — no Session reads, no IO. See
[apps/server/src/transcode/render.ts](apps/server/src/transcode/render.ts).

### PlaybackMethod
`direct-play | direct-stream | partial-transcode | transcode`. Drives whether
ffmpeg spawns at all, and which rendition ladder applies.

### Profile
A named encode target: `{ name, videoBitrate, audioBitrate, width, height }`.
Renditions are Profiles chosen for the current Session's ladder. See
[server/src/transcode/profiles.ts](server/src/transcode/profiles.ts).

### Rendition
A Profile that's actually being produced by the current ffmpeg run. Multiple
renditions = multiple ABR variants. Tone-mapped HDR Sessions are single-
rendition by policy.

### PlaybackOrchestrator
The module that owns the create-Session flow end-to-end: validates inputs,
builds the ProbeView, runs `decidePlayback`, picks Profiles, calls
`SessionManager.create`, spawns ffmpeg, launches subtitle extraction. Returns
`{ info, ready }` — info synchronously, ready as a Promise that resolves
when ffmpeg signals session-ready. Replaces ~80 lines of orchestration that
previously lived in `POST /sessions`. See
[server/src/session/playback.ts](server/src/session/playback.ts).

### Spawner
The injectable seam between the PlaybackOrchestrator and `spawnFfmpeg`. In
production it's `spawnFfmpeg` from `transcode/ffmpeg.ts`; in tests it's a
fake that resolves or rejects on demand. Two adapters = real seam (per
[LANGUAGE.md](https://github.com/anthropic-experimental/claude-skills) terms).

### SessionManager
Storage layer for Sessions: ID + reconnect-token allocation, the Map, attach
timer, destroy (kills ffmpeg + cleans session dir). Below the
PlaybackOrchestrator. See [server/src/session/manager.ts](server/src/session/manager.ts).

### SessionRuntime
Per-Session state machine that owns the ffmpeg-restart lifecycle. State is a
discriminated union `idle | restarting | destroyed`. Owns `startSegment`,
`seekPositionMs`, and the restart lock previously expressed as
`session.ffmpegRestartInFlight`. Exposes transitions
(`seekTo`, `changeAudioTrack`, `changeProfile`, `applyRestart`) that return
`{ok:true} | {ok:false, reason:'busy'|'destroyed'}`. Created by the
PlaybackOrchestrator alongside the Session; retrieved via
`SessionManager.getRuntime(id)`. See
[server/src/session/runtime.ts](server/src/session/runtime.ts).

### SegmentDecision
Output of `SessionRuntime.requestSegment(n)` — `'serve' | 'wait' | 'restart'`.
The segment route uses this to decide between serving from disk, waiting for
the current ffmpeg run to produce the segment, and triggering an
`applyRestart` outside the current run's window.

### ProgressEvent
A `{ positionMs, durationMs }` update from the client over WS. Batched by the
`ProgressFlusher` and written to the `progress` table every ~30 s + on
WS close (final flush).

## Transport

### HLS session dir
The on-disk directory under `cacheDir` where ffmpeg writes segments and
per-rendition `.m3u8` playlists for one Session. Created with the Session;
removed on destroy.

### reconnectToken
Long random opaque token returned at session create. Lets a client reattach
to a session after a WS drop without exposing the session ID in URLs.
