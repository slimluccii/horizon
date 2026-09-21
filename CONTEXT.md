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
[apps/server/src/contexts/identity/infrastructure/persistence/userRepo.ts](apps/server/src/contexts/identity/infrastructure/persistence/userRepo.ts).

### Device mode
A login session belongs to a device and carries a grant: the profiles it may act
as. A **personal device** has a grant of one, the person who logged in. A
**shared device** has the whole household in its grant, shows a picker, and lets
anyone pick any profile without a password, including a profile that has none. A
session whose grant holds more than one profile is shared by definition, a paired
TV included, and always runs with role `member`: it cannot manage the server or
the household, and cannot pair further devices for the household. Only the head
of a household can share a device (`POST /auth/device`), freely right after
login and with the password later. The acting profile travels in
`X-Horizon-Profile` and is checked against the grant and the household on every
request. Nobody is listed before login; `GET /auth/state` only says whether the
first account still has to be made.

A **profile PIN** is optional and guards only the picker of a shared device. A
profile with a PIN is locked on a shared session until the PIN is entered there
(`POST /auth/profile-unlock`); the unlock lives on that session and is dropped
everywhere when the PIN changes. While locked, the profile is refused with
`profile-locked`, and a request that names no profile acts as nobody when the
person who logged in is the locked one. Five wrong PINs make that device wait
five minutes. A personal device never asks, because its owner typed a password.
Anyone sets their own PIN, the head of a household anyone's in it, always with
their password and never from a shared device (`POST /auth/profile-pin`). See
[apps/server/src/contexts/identity/infrastructure/http/auth.ts](apps/server/src/contexts/identity/infrastructure/http/auth.ts).

## Configuration

### ServerSettings
Runtime operator settings are stored in a singleton `server_settings` DB row (id=1, enforced by `CHECK (id = 1)`). Choosing a singleton row over a key/value table gives each knob a native SQL type, a hardcoded default, and makes the whole row atomically readable and writable.

The `seeded_from_env` column is a one-time bootstrap flag. On first boot after upgrade (when `seeded_from_env = 0`), `bootstrapFromEnv` reads the current `HORIZON_*` environment variables and applies them to the row, then flips `seeded_from_env = 1`. Subsequent boots skip the overlay entirely — the row is the source of truth once seeded. This preserves operator intent across upgrades without re-reading env on every restart.

Consumers must call `serverSettings.get()` rather than `loadConfig()` for live settings. The `get()` call is cheap (returns cached values; cache is invalidated on `update()`). Wire a thunk — `getWatchedThresholdPct: () => serverSettings.get().watchedThresholdPct` — so consumers pick up changes without restart.

Every config-consuming module must wire such a getter, never snapshot a value at construction. Established getters: `progressRepo` (`getWatchedThresholdPct`), `MetadataRefreshWorker` (a `() => MetadataRefreshConfig` getter read at the start of each `run()`, so `metadataBatchSize` / `metadataMaxAge*` apply on the next run), and `SessionManager.create()` (reads `maxSessions` / `wsAttachMs` live per session). When adding a new live-tunable setting, wire it through one of these getters — a constructor-time snapshot will silently go stale after a PATCH /settings/server.

The `metadata_max_age_*_days` columns are stored in **days** (matching the `HORIZON_METADATA_MAX_AGE_*_DAYS` env-var unit). Consumers convert to milliseconds at the edge when wiring into workers (`days * 86_400_000`).

Future schema additions (v5+) get only their hardcoded column defaults on existing rows — `seeded_from_env` will already be 1, so the bootstrap pass does not apply. A v5+ migration that adds a column should run its own targeted overlay for that column's env var.

See [apps/server/src/contexts/settings/infrastructure/persistence/serverSettings.ts](apps/server/src/contexts/settings/infrastructure/persistence/serverSettings.ts).

## Library

### MediaItem
A single playable artifact, in the wire/domain shape. `kind` is one of
`movie | show | episode`. Returned by every `MediaRepo.get*` / `list*` /
`getByTmdbId` method that wasn't explicitly named for internal use.
NO `filePath`, NO DB bookkeeping (firstSeenAt/lastSeenAt/deletedAt/mtimeMs/
sizeBytes), NO metadata-refresh state (tmdbId, metadataFetched*, etc) — those
live on MediaItemRow. Wire-safe by construction; routes can serialize
MediaItem directly without leaking server internals. The shape is defined once,
in the SDK ([libs/sdk/src/library/mediaItem.ts](libs/sdk/src/library/mediaItem.ts)),
and the server's MediaItem is that type, so server and web cannot drift. See
[apps/server/src/contexts/library/infrastructure/persistence/media.ts](apps/server/src/contexts/library/infrastructure/persistence/media.ts).

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

### Media identity
What a MediaItem id is derived from. Never the file path, so a rename, a
quality upgrade or a moved library root keeps watch progress and metadata. A
movie is its `{tmdb-…}` tag, else `{imdb-…}`, else normalized title plus year.
A show is its `{tvdb-…}` tag, else `{tmdb-…}`, else `{imdb-…}`, else normalized
folder title plus year. An episode is its show id plus season and episode.
Adding a tag to an untagged item changes its id once. When several files
resolve to one id, the largest file wins and the rest are reported as
`ScanResult.duplicates`. See
[apps/server/src/contexts/library/domain/identity.ts](apps/server/src/contexts/library/domain/identity.ts).

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

**Track-index bounds invariant.** A client-supplied `audioTrackIndex` /
`subtitleTrackIndex` is validated at *both* entry points before it can reach
ffmpeg — an out-of-range index is otherwise a trivial mid-session DoS (the
ffmpeg run crashes). At session create, `PlaybackOrchestrator.startPlayback`
checks the index against the probed `MediaItem` (rejecting with
`audio-track-invalid` / `invalid-input`). Mid-session switches over the WS are
checked in the `audio-track` handler against `Session.audioTrackCount` /
`subtitleTrackCount`, which are stamped at create from the same probe (the
`PlaybackPlan` does not carry the track list, so the counts live on the
Session). The counts are stable because a MediaItem is immutable for the life
of a Session.

### Keyframe index and stream copy
A stream copy (`direct-stream`, `partial-transcode`) cannot cut a segment
anywhere but at a source keyframe, so its playlist cannot be the fixed
one-second grid an encode uses. The library keeps a keyframe index per file
(presentation and decode time of every video keyframe, tied to the file's mtime
and size) and a copy session cuts one segment per keyframe gap. A file without a
usable index is transcoded, and asking to play it moves it to the front of the
background indexer, which otherwise works through the library while nobody is
watching. Two ffmpeg facts shape the restart arguments: input seeking lands on
an earlier keyframe than asked when the stream has B-frames, and a stream copy
is trimmed by decode time. See
[apps/server/src/contexts/playback/domain/timeline.ts](apps/server/src/contexts/playback/domain/timeline.ts)
and [apps/server/src/contexts/library/application/keyframeIndexer.ts](apps/server/src/contexts/library/application/keyframeIndexer.ts).

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
restarts. See [apps/server/src/contexts/playback/domain/plan.ts](apps/server/src/contexts/playback/domain/plan.ts).

### RenderContext
Per-spawn runtime context for ffmpeg arg rendering: `{ sourceFilePath,
sessionDir, startSegment, seekPositionMs }`. Built fresh each spawn by the
restart actuator (or the orchestrator on first spawn). The Renderer
(`transcode/render.ts`) consumes a PlaybackPlan + RenderContext + HwAccel and
emits ffmpeg argv. Pure function — no Session reads, no IO. See
[apps/server/src/contexts/playback/application/render.ts](apps/server/src/contexts/playback/application/render.ts).

### PlaybackMethod
`direct-play | direct-stream | partial-transcode | transcode`. Drives whether
ffmpeg spawns at all, and which rendition ladder applies.

### Sidecar subtitle
An external subtitle file (`Movie (2010).en.srt`) next to the media file.
Discovered during Scan (`discoverSidecarSubtitles` +
`mergeSidecarTracks`) and appended AFTER the embedded tracks so embedded
indexes keep doubling as ffmpeg `0:s:N` positions. Marked `external: true`
with `externalFileName` (basename only) on the wire SubtitleTrack. Converted
per-file to WebVTT at session create. See
[apps/server/src/contexts/library/infrastructure/fs/sidecars.ts](apps/server/src/contexts/library/infrastructure/fs/sidecars.ts).

### Burn-in subtitle
An image-based subtitle track (PGS/VobSub — `embeddable: false`,
`external` unset) composited onto the video by ffmpeg (`overlay` before
scale/split in the filter graph). Selecting one forces `method: 'transcode'`
(and tone-maps HDR sources — the transcode ladder is SDR). Carried on the
plan as `burnInSubtitleIndex`. Mid-session switches on a transcode session go
through `SessionRuntime.changeBurnInSubtitle` (restart-with-reset + a
`track-changed { restarted: true }` WS notify → client reloads HLS); on a
copy-based session the web client recreates the whole session instead.

### Bandwidth demote
The server-side reaction to sustained under-bandwidth `bandwidth-report`s on a
copy-video HLS session (direct-stream / partial-transcode): after
`DEMOTE_CONSECUTIVE_REPORTS` low reports with a draining buffer, the session's
plan is rebuilt as a transcode sized to the measured link
(`Session.rebuildPlanForBitrate`, a closure stamped by the orchestrator) and
swapped in via `SessionRuntime.applyPlanSwap`. Fires at most once per session.
Within a transcode ladder, rendition switching is client-side (hls.js) — the
old per-quality server-restart ABR stays dead (init.mp4 rewrites break MSE).
Initial quality is bandwidth-aware on the client: the SDK persists the last
measured estimate (localStorage, 24 h TTL) and folds it into
`capabilities.maxBitrate` at session create, combined with the profile's
`preferredQuality` cap. The bitrate fit check is real because `video_bitrate`
is stored on media rows (v4 migration; size/duration estimate for rows
scanned before it). See
[apps/server/src/contexts/playback/infrastructure/ws/handler.ts](apps/server/src/contexts/playback/infrastructure/ws/handler.ts)
(`computeDemote`).

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

It is also the **proof-of-knowledge credential** for every session data route:
the `sessionId` in a URL is *not* a capability on its own. Holding it does not
grant access to media bytes or let you tear a session down. The caller must echo
the `reconnectToken` back on `GET /sessions/:id/stream.m3u8`,
`/renditions/:r.m3u8`, `/renditions/:r/:seg`, `/direct`,
`/subtitles/:trackIdx.vtt`, and `DELETE /sessions/:id`, otherwise the route
replies `400 invalid-reconnect-token`. (`DELETE` of an unknown/already-gone
session is an idempotent `204` and needs no token.) The token is accepted via
the `X-Reconnect-Token` header (hls.js playlist/segment loads + the teardown
`fetch`) or a `token` query param for transports that cannot set headers — a
browser `<video src>` (direct-play) or `<track src>` (subtitles). Treat the
`sessionId` as opaque and the `reconnectToken` as the secret. See
[apps/server/src/contexts/playback/infrastructure/http/segments.ts](apps/server/src/contexts/playback/infrastructure/http/segments.ts)
(`requireReconnectToken`).

### WS attach handshake
A freshly attached `/sessions/:id/ws` socket is **unauthenticated**: the server
processes only the `hello` message and drops every other command (seek,
quality-override, audio-track, subtitle-track, park/resume, progress,
bandwidth-report) until the handshake completes. `hello` authenticates the
socket — a present-but-mismatched `reconnectToken` closes the socket with code
`4401 invalid-reconnect-token`; a tokenless `hello` is the legitimate
initial-attach path (the token is only learned from the `session-ready` reply,
so the first connection cannot echo it). This gate prevents a party who guessed
the session id from driving playback or mutating session state before the
legitimate client's `hello` arrives. Each new socket (including reconnects)
must re-handshake — auth state is reset on attach. See
[apps/server/src/contexts/playback/infrastructure/ws/handler.ts](apps/server/src/contexts/playback/infrastructure/ws/handler.ts).
