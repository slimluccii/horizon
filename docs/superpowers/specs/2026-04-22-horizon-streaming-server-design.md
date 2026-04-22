# Horizon — Streaming Server Design Spec
**Date:** 2026-04-22  
**Status:** Approved for implementation

---

## Overview

Horizon is a personal media streaming server with an SDK and React test app. It streams Blu-ray remux files (Dolby Vision, HDR10, TrueHD, EAC3) stored in Sonarr/Radarr directory conventions. The server identifies each client's capabilities and uses the highest-quality playback method available — direct play, direct stream, partial transcode, or full transcode — with adaptive bitrate adjustment driven by real-time buffer and bandwidth signals.

**Out of scope (this version):** user authentication, rich metadata (posters, descriptions, ratings), external metadata APIs (TMDb/TVDb), database persistence, burn-in for image-based subtitles (PGS/VobSub) — only text subtitles (SRT/ASS) pass through as WebVTT in v1.

**In scope (added after review):** multiple audio track selection, text subtitle track selection (SRT/ASS → WebVTT), hardware-accelerated decode, HDR→SDR tone-mapping, WS reconnect grace window, session TTL, ffprobe cache, multi-rendition HLS.

---

## Repository Structure

```
horizon/
├── server/     # Fastify API server
├── sdk/        # TypeScript SDK (publishable npm package)
└── app/        # React SPA test app
```

---

## 1. Server

### 1.1 Technology

- **Runtime:** Node.js + TypeScript
- **HTTP framework:** Fastify
- **Media processing:** FFmpeg + ffprobe (system install)
- **WebSocket:** Fastify WebSocket plugin (with ping/pong keepalive every 15s)
- **Segments:** written to OS temp dir, cleaned up per-session
- **Config:** env vars (`HORIZON_MOVIES_ROOT`, `HORIZON_SHOWS_ROOT`, `HORIZON_PORT`, `HORIZON_CORS_ORIGINS`, `HORIZON_CACHE_DIR`)
- **Defaults:** server port `7777`, app dev port `5173`, CORS open to `HORIZON_CORS_ORIGINS` (comma-separated; `*` permitted in dev only)
- **Security note:** v1 has no authentication. Do not expose server to the public internet. Intended for LAN / VPN access only.

### 1.2 File Scanner

Walks configured root directories at startup and on `POST /library/rescan`. Supports two root types:

- **Movies root** — expects `Title (Year)/Title (Year).mkv`
- **Shows root** — expects `Show Name/Season 01/Show Name - S01E01.mkv`

For each file: runs `ffprobe` to extract duration, resolution, video codec, audio tracks (codec, channels, language, title), subtitle tracks (codec, language, forced flag), HDR metadata (Dolby Vision profile, HDR10, HDR10+), and container format. Stores results in-memory.

**ffprobe cache:** results written to `{HORIZON_CACHE_DIR}/probe-cache.json`, keyed by `filePath + mtime + size`. On rescan, cached entries reused when key matches; changed/new files re-probed. Cache persists across restarts. Avoids minutes-long startup on libraries with hundreds of files.

**Collection detection (movies only):**
1. Strip trailing year tag `(YYYY)` from folder/title.
2. Strip trailing collection tokens: `Part <N>`, `Chapter <N>`, `Vol. <N>`, `Volume <N>`, standalone trailing Roman numerals (`II`–`XX`).
3. **Do not strip bare trailing digits** (prevents `Blade Runner 2049` → `Blade Runner`).
4. Group movies by stripped base name. Collection formed only when 2+ movies share it.
5. Sort members by release year ascending.

**Media IDs:** `mediaId` is SHA-1 of absolute file path, stable across restarts while paths unchanged. Move/rename requires rescan; active sessions referencing old id will error (already-running session keeps its FFmpeg alive with original path).

### 1.3 API Endpoints

All responses are JSON. All errors return `{ error: string, code: string }`.

#### Library

Media item shape:

```jsonc
{
  "id": "…sha1…",
  "title": "The Godfather",
  "year": 1972,
  "duration": 10500,            // seconds
  "resolution": "3840x2160",
  "videoCodec": "hevc",
  "hdr": { "dv": true, "dvProfile": 7, "hdr10": true, "hdr10plus": false },
  "audioTracks": [
    { "index": 0, "codec": "truehd", "channels": 8, "language": "eng", "title": "Atmos", "default": true }
  ],
  "subtitleTracks": [
    { "index": 0, "codec": "pgs", "language": "eng", "forced": false, "embeddable": false },
    { "index": 1, "codec": "srt", "language": "eng", "forced": false, "embeddable": true }
  ],
  "container": "matroska",
  "filePath": "/movies/…"        // absolute path, server-only info
}
```

`embeddable: true` = subtitle can be converted to WebVTT and served. `embeddable: false` = image-based (PGS/VobSub), not supported for v1 playback.

```
GET  /library/movies
     → [MediaItem]

GET  /library/movies/collections
     → [{ id, name, movies: [MediaItem] }]

GET  /library/movies/collections/:collection
     → { id, name, movies: [MediaItem] }

GET  /library/shows
     → [{ id, title, seasonCount, episodeCount }]

GET  /library/shows/:show
     → { id, title, seasons: [{ number, episodeCount }] }

GET  /library/shows/:show/seasons
     → [{ number, episodeCount }]

GET  /library/shows/:show/seasons/:season
     → [MediaItem + { episode: number }]

POST /library/rescan
     → { status: "scanning" }
```

#### Sessions

```
POST   /sessions
       Body: {
         mediaId: string,
         capabilities: ClientCapabilities,
         audioTrackIndex?: number,       // defaults to default/first audio track
         subtitleTrackIndex?: number     // null/omitted = off
       }
       → { sessionId, method, streamUrl, wsUrl, profile, selectedAudioTrack, selectedSubtitleTrack }
       Server evaluates capabilities and picks method before responding.
       FFmpeg starts pre-buffer on response; WS attach window applies (see §1.10).

GET    /sessions/:id/stream.m3u8            HLS master playlist (multi-rendition for transcode, single for direct-stream)
GET    /sessions/:id/renditions/:r.m3u8     HLS media playlist per rendition
GET    /sessions/:id/renditions/:r/:seg     HLS segment (fMP4)
GET    /sessions/:id/subtitles/:trackIdx.vtt  WebVTT subtitle track (text subs only)
GET    /sessions/:id/direct                 Raw file, HTTP range supported (direct play)
POST   /sessions/:id/audio-track            Body: { index: number } — switch audio track, triggers transcode restart
POST   /sessions/:id/subtitle-track         Body: { index: number | null } — switch/disable subtitles
DELETE /sessions/:id                        Explicit teardown
```

#### Health

```
GET /health    → { status: "ok", ffmpeg: string, hwAccel: string }
```

### 1.4 WebSocket Protocol

`ws://host/sessions/:id/ws`

Server sends ping every 15s; missed pong for 30s treated as dropped connection.

**Client → Server:**

```jsonc
// Optional initial hello (lets server correlate reconnects — see §1.4.1)
{
  "type": "hello",
  "reconnectToken": "…"        // optional, from prior session-ready
}

// Sent after every HLS segment download completes
{
  "type": "bandwidth-report",
  "kbps": 15000,
  "bufferSeconds": 12.4,
  "segmentDownloadMs": 340
}

// Seek request
{
  "type": "seek",
  "positionMs": 154000
}

// User-forced quality override
{
  "type": "quality-override",
  "bitrate": 8000             // kbps; 0 = auto (resume ABR)
}

// Client explicitly parking the session (background tab, minimized) —
// server pauses FFmpeg process without killing
{ "type": "park" }

// Resume from park
{ "type": "resume" }
```

**Server → Client:**

```jsonc
// Session is ready, begin playback
{
  "type": "session-ready",
  "method": "direct-stream",   // "direct-play" | "direct-stream" | "partial-transcode" | "transcode"
  "streamUrl": "/sessions/:id/stream.m3u8",
  "profile": { "resolution": "1920x1080", "videoBitrate": 20000, "audioBitrate": 640, "videoCodec": "hevc", "audioCodec": "eac3" },
  "reconnectToken": "…"        // opaque; pass back via hello on reconnect
}

// Bitrate profile changed (transcode only — for multi-rendition, client-side ABR does not fire this)
{
  "type": "quality-changed",
  "profile": { "resolution": "1280x720", "videoBitrate": 4000, "audioBitrate": 128, "videoCodec": "h264", "audioCodec": "aac" },
  "reason": "bandwidth-drop"   // "bandwidth-drop" | "bandwidth-increase" | "buffer-low" | "user-override" | "hdr-fallback"
}

// Audio/subtitle track change confirmation
{ "type": "track-changed", "audioTrackIndex": 1, "subtitleTrackIndex": null }

// Non-fatal warning
{
  "type": "warning",
  "code": "hw-accel-unavailable",
  "message": "Falling back to software encoding"
}

// Fatal error — see §1.11 for code taxonomy
{
  "type": "error",
  "code": "transcode-failed",
  "message": "FFmpeg exited with code 1",
  "fatal": true
}

// Playback ended (file finished)
{ "type": "ended" }
```

#### 1.4.1 Disconnect / Reconnect Handling

- **WS close:** server enters **grace window** (default 10s, configurable via `HORIZON_WS_GRACE_MS`).
- During grace: FFmpeg keeps running, segments remain on disk, session marked `detached`.
- Client reconnects to same `wsUrl` and sends `{ type: "hello", reconnectToken }`. Server resumes session in place; no FFmpeg restart, no rebuffer.
- If grace window expires without reconnect: FFmpeg killed, temp dir deleted, session destroyed.
- Explicit `DELETE /sessions/:id` skips grace window — immediate teardown.
- Explicit `park` pauses FFmpeg via `SIGSTOP`; `resume` sends `SIGCONT`. Good for background tabs.

### 1.5 Playback Decision Tree

Evaluated per-request in order. First match wins. `video-ok` = source video codec AND HDR format (DV profile, HDR10, HDR10+, or SDR) supported by client AND source bitrate ≤ `maxBitrate`. `audio-ok` = selected audio track codec + channel count supported.

```
1. video-ok AND audio-ok AND container-ok        → direct-play
2. video-ok AND audio-ok AND container NOT ok    → direct-stream (remux)
3. video-ok AND audio NOT ok                     → partial-transcode (copy video, transcode audio)
4. video NOT ok (codec, HDR mismatch, or bitrate) → full-transcode
                                                    (with tone-mapping if HDR source → SDR client)
```

**HDR handling:**
- Client capabilities declare supported HDR formats (e.g., `["dv","hdr10"]`, `["hdr10"]`, `[]` = SDR only).
- If source HDR format not in client list: fall back to full-transcode with tone-map filter chain.
- Tone-mapping filter: `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`. Applied before encoder.
- Dolby Vision profile 7 FEL: no FFmpeg tone-mapping path currently — treat as HDR10 source for tone-mapping purposes (extract BL layer only).

**Bitrate cap in decision:** if source video bitrate exceeds `maxBitrate` → force full-transcode even when codec supported (avoids direct-stream of 80 Mbps UHD to 20 Mbps client).

For all methods that involve FFmpeg, hardware acceleration is applied where available (see §1.6).

### 1.6 Hardware Acceleration

Detected once at server startup by probing FFmpeg (`ffmpeg -hwaccels` and `ffmpeg -encoders`). Both decode and encode accelerated where available.

**Encoder priority:**
1. `videotoolbox` (Apple) — `h264_videotoolbox`, `hevc_videotoolbox`
2. NVIDIA — `h264_nvenc`, `hevc_nvenc`
3. Intel Quick Sync — `h264_qsv`, `hevc_qsv` (requires `-init_hw_device qsv=hw -filter_hw_device hw`)
4. CPU fallback — `libx264`, `libx265`

**Decoder (hwaccel on input):** matching family when available — `-hwaccel videotoolbox`, `-hwaccel nvdec`, `-hwaccel qsv`. Falls back to software decode when family missing. Decode accel critical for 4K HEVC to avoid CPU saturation.

**Runtime fallback:** if a hardware encode fails mid-session (driver, allocation error), FFmpeg is restarted with software encoder at same position, client receives `{ type: "warning", code: "hw-accel-unavailable" }`.

Selected encoder injected into all transcode FFmpeg commands. Config override available via `HORIZON_FORCE_ENCODER=libx264|hevc_nvenc|...` for debugging.

### 1.7 Bitrate Profiles (Full Transcode)

| Profile   | Video Bitrate | Audio Bitrate | Resolution  |
|-----------|---------------|---------------|-------------|
| 4K        | 40 Mbps       | 256 kbps AAC  | 3840×2160   |
| 1080p-hi  | 20 Mbps       | 256 kbps AAC  | 1920×1080   |
| 1080p     | 8 Mbps        | 192 kbps AAC  | 1920×1080   |
| 720p      | 4 Mbps        | 128 kbps AAC  | 1280×720    |
| 480p      | 2 Mbps        | 96 kbps AAC   | 854×480     |

Initial profile ceiling selected from client-reported `maxBitrate`. Direct stream and partial transcode pass source bitrate through unchanged. If `maxBitrate` is set and source bitrate exceeds it, server falls back to full transcode rather than attempting to cap a stream-copy.

Audio: transcode always produces stereo AAC by default. If client reports multi-channel support (`channels: 6` or `8`) and codec support (AC3/EAC3/AAC 5.1), server preserves original channel layout when partial-transcode or passes through on direct-stream.

### 1.8 Adaptive Bitrate Logic

**Architecture: multi-rendition HLS master playlist.**

For full-transcode sessions, server generates multiple renditions in parallel (up to `HORIZON_MAX_RENDITIONS`, default 3) based on client ceiling. Example ceiling = 20 Mbps → renditions: 1080p-hi, 1080p, 720p. Master playlist lists all; client (`hls.js`) performs ABR natively without server restart. No dead air on quality switch. Cost: 2–3× CPU vs single-rendition; acceptable for typical 1 concurrent viewer.

**Rendition ladder selection:**
- Top rendition = profile ≤ client `maxBitrate`
- Include 2 profiles below top for headroom
- Never exceed source resolution (no up-scale)
- Minimum 1 rendition (if ceiling forces single profile, runs single-rendition mode)

**Single-rendition fallback:**
- `direct-stream` and `partial-transcode`: always single rendition (no re-encode budget).
- Server-side ABR logic below only applies in single-rendition mode (e.g., forced by `HORIZON_MAX_RENDITIONS=1` or hardware budget).

**Single-rendition ABR rules** (still triggered on every `bandwidth-report`):

| Condition | Action |
|-----------|--------|
| `bufferSeconds` < 4 | Emergency: step down 2 profiles |
| `bufferSeconds` < 8 | Step down 1 profile |
| `kbps` < currentProfile.videoBitrate × 1.2 | Step down 1 profile |
| `kbps` > nextProfile.videoBitrate × 1.5 AND `bufferSeconds` > 15 | Step up 1 profile |

**Anti-thrash:** after any profile change, 15s cooldown before next change in same direction (step-down emergencies ignore cooldown).

On single-rendition profile change: kill current FFmpeg, start new at current playback position, emit `quality-changed`. Client re-fetches playlist. Pre-buffer 3 new segments before advertising.

**Segment duration:** 4 seconds. In multi-rendition mode, rendition switch latency matches `hls.js` default (~1 segment). In single-rendition mode, switch latency = pre-buffer time (~3-6s).

**Client-side reporting:** even in multi-rendition mode, client sends `bandwidth-report` so server can log quality changes (via `hls.js` level-switched event forwarded as informational WS message; no server action).

### 1.9 HLS Segment Pipeline

On transcode/remux session start:
1. FFmpeg launched with per-rendition output (for multi-rendition: single ffmpeg with multiple outputs via `-map` + `-b:v:0 X -b:v:1 Y ...`, preferred; or N separate ffmpeg processes when hwaccel context can't be shared).
2. Pre-generate first 3 segments per rendition before resolving POST /sessions → `session-ready` emitted via WS when ready.
3. FFmpeg runs continuously, writing fMP4 segments + per-rendition `media.m3u8` to session temp dir.
4. Master playlist served from in-memory template, referencing `/sessions/:id/renditions/:r.m3u8`.
5. Subtitle tracks (text/embeddable) extracted concurrently via separate ffmpeg, written as WebVTT.
6. On session end / grace window expiry / explicit DELETE: SIGTERM FFmpeg, wait 2s, SIGKILL if still running, delete session temp dir.

### 1.10 Session Lifecycle

- **Creation:** `POST /sessions` creates session, starts FFmpeg (pre-buffer phase).
- **Attach window:** client has 10s (configurable `HORIZON_WS_ATTACH_MS`) to connect WS. If no WS attach → session killed, FFmpeg terminated, 408 returned to any subsequent request on session id.
- **Active:** WS connected, client playing.
- **Detached:** WS closed, grace window running (default 10s).
- **Reattached:** WS reconnects with `reconnectToken` → returns to Active, no FFmpeg restart.
- **Destroyed:** grace expired OR explicit DELETE OR fatal error → FFmpeg killed, temp dir deleted.

Max concurrent sessions per server: `HORIZON_MAX_SESSIONS` (default 4). Further POST returns 503.

### 1.11 Error Taxonomy

`code` values returned in both REST error responses and WS `error` messages:

| Code | Meaning | Fatal |
|------|---------|-------|
| `media-not-found` | `mediaId` not in index | yes |
| `session-not-found` | `sessionId` unknown/expired | yes |
| `session-attach-timeout` | WS not connected within attach window | yes |
| `capabilities-unsupported` | Client reports no playable codec even after transcode | yes |
| `transcode-failed` | FFmpeg exited non-zero | yes |
| `hw-accel-unavailable` | Encoder failed, fell back to CPU | no (warning) |
| `file-read-error` | Source file I/O error | yes |
| `subtitle-not-embeddable` | Requested PGS/VobSub subtitle | no (warning) |
| `audio-track-invalid` | Requested track index out of range | yes |
| `max-sessions` | Server at capacity | yes |
| `probe-failed` | ffprobe failed on source | yes |

---

## 2. SDK

### 2.1 Package Structure

```
sdk/
├── src/
│   ├── client.ts          # HorizonClient — entry point
│   ├── session.ts         # PlaybackSession — WS + playback lifecycle
│   ├── capabilities.ts    # Auto-detect device capabilities
│   ├── bandwidth.ts       # Per-segment bandwidth measurement
│   └── index.ts           # Public exports
├── package.json
└── tsconfig.json
```

### 2.2 Public API

```typescript
// Instantiate
const client = new HorizonClient({ baseUrl: 'http://server:7777' })

// Library
const movies      = await client.library.listMovies()
const collections = await client.library.listCollections()
const shows       = await client.library.listShows()
const episodes    = await client.library.listEpisodes(showId, season)

// Playback — capabilities auto-detected, can be overridden
const session = await client.play(mediaId, {
  capabilities?: Partial<ClientCapabilities>,  // merged with auto-detected
  audioTrackIndex?: number,                    // default: media.audioTracks[0]
  subtitleTrackIndex?: number | null,          // default: null (off)
  onReady:          (info: SessionInfo) => void,
  onQualityChange:  (profile: QualityProfile, reason: string) => void,
  onTrackChange:    (info: { audio?: number, subtitle?: number | null }) => void,
  onWarning:        (w: HorizonWarning) => void,
  onEnded:          () => void,
  onError:          (err: HorizonError) => void,
})

// session.method           → 'direct-play' | 'direct-stream' | 'partial-transcode' | 'transcode'
// session.streamUrl        → feed to hls.js (transcode/stream) or <video src> (direct play)
// session.subtitleUrls     → { [trackIdx: number]: string } WebVTT URLs for embeddable subs
// session.profile          → current quality profile
// session.connectionState  → 'attaching' | 'active' | 'detached' | 'destroyed'
// session.seek(ms)                         → send seek via WebSocket
// session.setQuality(kbps | 'auto')        → override / resume ABR
// session.setAudioTrack(index)             → switch audio (triggers transcode restart server-side)
// session.setSubtitleTrack(index | null)   → switch/disable subtitles
// session.park() / resume()                → background tab optimization
// session.disconnect()                     → explicit DELETE /sessions/:id
```

**Auto-cleanup:** SDK registers `beforeunload` and `pagehide` listeners that call `session.disconnect()`. Disabled via `client.play(..., { autoCleanup: false })`.

**Reconnect:** `PlaybackSession` automatically retries WS within grace window (exponential backoff, max 3 tries). After failure: `onError` with `session-destroyed`.

**Error types (enum-exported):**

```typescript
export type HorizonErrorCode =
  | 'media-not-found' | 'session-not-found' | 'session-attach-timeout'
  | 'capabilities-unsupported' | 'transcode-failed' | 'file-read-error'
  | 'audio-track-invalid' | 'max-sessions' | 'probe-failed' | 'session-destroyed'
  | 'network-error'

export interface HorizonError { code: HorizonErrorCode; message: string; fatal: boolean }
```

### 2.3 Capability Detection

`capabilities.ts` uses `MediaSource.isTypeSupported()` for codec detection and `navigator.userAgent` for device hints. Returns a `ClientCapabilities` object. Works in browsers; non-browser environments can pass capabilities manually.

### 2.4 Bandwidth Measurement

`bandwidth.ts` hooks into `hls.js` fragment-loaded events to measure per-segment download time and compute bandwidth. Emits `bandwidth-report` to server after each segment. Falls back to interval-based estimation when not using `hls.js` (direct play).

---

## 3. Test App

### 3.1 Technology

- **Framework:** React + TypeScript (Vite)
- **Player:** `hls.js` for HLS streams, native `<video>` for direct play
- **SDK:** local workspace reference to `../sdk`

### 3.2 Structure

```
app/
├── src/
│   ├── pages/
│   │   ├── Library.tsx      # Browse movies, shows, collections
│   │   └── Player.tsx       # Playback page
│   ├── components/
│   │   ├── MediaCard.tsx
│   │   ├── VideoPlayer.tsx  # hls.js + direct play integration
│   │   └── QualityOverlay.tsx
│   └── main.tsx
```

### 3.3 Player UI

The player page displays:
- Full-screen video element with loading spinner while buffering
- **Method badge:** `DIRECT PLAY` / `DIRECT STREAM` / `TRANSCODE`
- **Quality indicator:** current resolution + bitrate (e.g., `1080p · 8 Mbps`)
- **Buffer bar:** live buffer level in seconds
- **Quality log:** last 5 quality switches with reason and timestamp
- **Audio track picker:** dropdown showing all available audio tracks (codec, channels, language)
- **Subtitle track picker:** dropdown with Off + embeddable tracks; non-embeddable (PGS) greyed out with tooltip
- **Keyboard controls:** Space = play/pause, ← → = seek ±10s, ↑ ↓ = volume, F = fullscreen, C = toggle subtitles

---

## 4. Key Design Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Stream format | HLS + fMP4 segments | Universal browser support via hls.js; fMP4 supports HEVC/DV direct-stream |
| Session control | WebSocket (ping/pong keepalive) | Bidirectional: client reports bandwidth, server pushes quality/track changes |
| Disconnect handling | 10s grace window + reconnectToken | Survives network blips without rebuffer |
| ABR architecture | Multi-rendition HLS master playlist | Client-side ABR via hls.js = zero dead air on switch (like YouTube) |
| Fallback single-rendition | Restart FFmpeg on profile change | Only when budget forces single rendition; pre-buffer 3 segs cushions |
| Hardware accel | Auto-detect encoder + decoder at startup | VideoToolbox (dev Mac), QSV (TrueNAS Intel), NVENC (future GPU) |
| HDR handling | Capability-gated + tone-map filter chain | Prevents green/washed playback on SDR screens |
| Subtitle handling | Text subs only in v1 | PGS/VobSub burn-in deferred — requires re-encode on every change |
| Library persistence | In-memory + disk probe cache | No DB; ffprobe cache keyed by path+mtime+size avoids slow rescans |
| Media IDs | SHA-1(absolute path) | Stable across restarts; rescan needed after file moves |
| Session TTL | 10s WS attach window + 10s grace | Prevents FFmpeg leaks on abandoned sessions |
| Max concurrency | 4 sessions default | Protects server CPU; configurable |
