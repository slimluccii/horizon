# Horizon

A self-hosted media server for one household. It scans a movie and series
library, enriches it with TMDB metadata, and streams to a web app and an Android
TV app, direct where the device can play the file and transcoded with ffmpeg
where it cannot. It is built to sit next to Sonarr, Radarr and a request app,
not to replace them.

Horizon is a personal project. It is written for a home server with a handful of
users, and it is not hardened or supported the way Plex or Jellyfin are.

## Status

Works, with automated tests:

- Library scan with Radarr and Sonarr naming, TMDB metadata, collections.
- Watch progress that survives renames and quality upgrades, because a title is
  identified by its `{tmdb-…}` or `{tvdb-…}` tag, or by title and year.
- Playback in the browser. Transcoding, stream copy, seeking and resume are
  tested end to end with real ffmpeg and a real browser. Direct play, subtitles
  and audio track switching have unit tests only.
- A webhook that rescans a folder the moment Sonarr or Radarr imports, renames
  or deletes something in it.
- Accounts with passwords, households, invites, and device pairing for TVs.

Not verified yet:

- Hardware transcoding in the Docker image. The image installs no VA driver, so
  an Intel iGPU may silently fall back to CPU encoding.
- The Android TV player on a real device. Its API client and WebSocket are
  tested against a live server; the player screen itself has not been run.

The web UI is unstyled on purpose. Layout and design come later.

## How it fits together

| Part | Path | Role |
|---|---|---|
| Server | `apps/server` | Fastify, SQLite and ffmpeg. Scans, serves the API, transcodes. |
| Web app | `apps/web` | React single-page app, served by the server in production. |
| Android TV | `apps/android-tv` | Kotlin, Compose for TV and Media3. |
| SDK | `libs/sdk` | TypeScript client and the wire types shared by server and web. |
| End-to-end tests | `apps/e2e` | Playwright against the real server and a real browser. |

The server is one process with one SQLite file. Everything it serves lives under
`/api`.

## Quick start

You need Docker, a folder with your media, and a folder for Horizon's data.

```bash
cp .env.example .env    # set HORIZON_MEDIA_HOST and HORIZON_DATA_HOST
docker compose up -d
```

Open `http://<host>:7777`. The first visit creates the owner account and lets
you pick which folders under the media mount are movies and which are series.

Settings that appear under Settings → Server, the TMDB token included, are read
from the environment on the first boot only. After that the database wins, so
change them in the web UI.

The full guide, including TrueNAS with Dockge, GPU passthrough and installing
the TV app on an Nvidia Shield, is in [docs/DEPLOY.md](docs/DEPLOY.md).

## Sonarr and Radarr

1. Put the id in your folder names in the Sonarr and Radarr naming settings:
   `{tmdb-12345}` for movies, `{tvdb-12345}` for series. Horizon then identifies
   a title by that id. Do this before the first scan: adding a tag later changes
   a title's id once, which drops its watch progress.
2. Generate a webhook key and add a Webhook connection in both apps that posts
   to `/api/webhooks/arr` with the key in an `X-Api-Key` header. The steps are in
   [docs/DEPLOY.md](docs/DEPLOY.md#sonarr-and-radarr).

No path mapping is needed. Horizon matches the folder names Sonarr and Radarr
send against its own library folders.

## Development

Node 22 or newer, and ffmpeg with ffprobe on your `PATH`.

```bash
npm install
npm run dev          # server on :7777, web on :5173 with /api proxied
npm test             # server, SDK and web unit tests
npm run e2e          # Playwright; needs `npx playwright install chromium` once
```

`npm run dev` starts from an empty database every time, so the first page is the
setup wizard.

The Android TV app builds with the JDK that Android Studio bundles:

```bash
cd apps/android-tv
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew :app:testDebugUnitTest :app:assembleDebug
```

## How playback is decided

For every session the server compares the file with what the device says it can
play and picks the cheapest method that works:

- **Direct play.** Container, codecs and bitrate all fit. The file is served as
  it is.
- **Stream copy.** The video fits but the container or the audio does not. The
  video is repackaged into HLS without re-encoding. A copy can only be cut at
  the source's keyframes, so Horizon keeps a keyframe index per file and builds
  the playlist from it. A file that has no index yet is transcoded, and a
  background job indexes the library while nobody is watching.
- **Transcode.** Everything else, including HDR to SDR tone mapping and burned-in
  image subtitles. The encoder is held about two minutes ahead of the player and
  old segments are deleted, so a session uses a few minutes of disk, not the
  whole film.

The vocabulary the code uses, and the reasons behind these choices, are in
[CONTEXT.md](CONTEXT.md).

## Layout

```
apps/server/src/contexts/   library, metadata, playback, identity, settings, activity
apps/server/src/platform/   composition root, database, HTTP server, scheduler
apps/web/src/features/      library, playback, identity, settings
apps/android-tv/            the TV app
libs/sdk/                   client and shared wire types
docs/                       deploy guide and design notes
```

A context only imports another context through its `index.ts`. A test in
`apps/server/src/platform/architecture.test.ts` enforces that.
