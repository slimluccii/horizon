# Android TV Client (Shield TV Pro) — Design

**Status:** approved for plan
**Primary target:** Nvidia Shield TV Pro (Tegra X1+, Android 11 / API 30, 3 GB RAM, 4K HDR + DV) — the reference device we test against
**Also supported:** Android TV / Google TV devices down to **Android 6.0 / API 23**, including:
  - Modern smart TVs (Sony / TCL / Hisense Google TV, ~2020+)
  - Chromecast with Google TV (HD + 4K)
  - ISP-provided Android TV set-top boxes (KPN / Odido interactive TV, Ziggo Next, etc.)
  - Older-gen Shields (2017 + 2019 4K tube)
**Target server:** existing Horizon server (Fastify + SQLite + ffmpeg) on the same LAN
**Goal:** feature parity with the web + Mac clients, no visual styling, maximum playback quality on whatever hardware the box actually has

---

## Scope

**In scope (v1):**

- Profile picker (list, pick, add, delete) backed by server `/users`
- Library screen: Movies / Series / Collections tabs + Continue Watching rail + grid
- Show detail screen: seasons + episode list
- Player: resume-from-position toast, Media3 ExoPlayer, back-to-dismiss
- WebSocket progress reporter (same contract as Mac + web clients)
- Poster art via Coil 3 (TMDB image proxy)

**Out of scope (v1):**

- Visual theme (colors, fonts, shapes, spacing polish) — Material defaults only
- Search screen (no IME, no remote typing)
- Setup / server-discovery screen (server URL via `local.properties`)
- Custom audio / subtitle / quality pickers in the player (Media3 defaults only)
- Settings screen
- Handheld / portrait / non-TV form factors
- Accessibility polish beyond Compose defaults

## Success criteria

- One-touch deploy from Mac: `./gradlew :app:installDebug` lands the APK on Shield via ADB
- Shield launcher tile opens the app and the profile picker renders
- Picking a profile → library grid renders titles from the real server
- D-pad navigates every screen end to end without getting stuck on a dead focus target
- Oppenheimer (4K DV HDR10 HEVC) **direct-plays** on Shield — no server transcode
- Progress reports reach the server and a subsequent launch offers to resume

## Architecture

```
tv/                             (standalone Gradle project)
├── settings.gradle.kts
├── build.gradle.kts             (top-level — plugins, toolchain)
├── gradle.properties
├── local.properties             (git-ignored; HORIZON_SERVER_URL=http://…)
├── gradle/libs.versions.toml    (version catalog)
└── app/
    ├── build.gradle.kts
    └── src/main/
        ├── AndroidManifest.xml
        ├── res/
        │   ├── drawable/banner.xml        (placeholder vector banner 320×180)
        │   ├── mipmap-anydpi-v26/ic_launcher.xml
        │   ├── values/strings.xml
        │   └── xml/network_security_config.xml   (allow cleartext on LAN)
        └── java/network/luuk/horizontv/
            ├── HorizonApp.kt              (Application — builds API client)
            ├── MainActivity.kt            (NavHost + top-level state)
            ├── app/AppState.kt            (active user holder)
            ├── api/
            │   ├── HorizonApi.kt          (typed endpoints over OkHttp)
            │   ├── Models.kt              (serialization types)
            │   ├── CapabilitiesProbe.kt   (MediaCodecList + Display HDR + AudioDeviceInfo)
            │   └── ProgressSocket.kt      (WebSocket reporter)
            └── ui/
                ├── ProfileListScreen.kt
                ├── LibraryScreen.kt       (tabs + CW rail + grid)
                ├── ShowDetailScreen.kt
                └── PlayerScreen.kt        (Media3 PlayerView + resume toast)
```

The Gradle project lives under `tv/` at the repo root, alongside `mac/`, `app/`, `server/`. Root `.gitignore` extended to exclude `tv/.gradle`, `tv/build`, `tv/app/build`, `tv/local.properties`.

## Stack (locked)

| Layer | Choice | Version |
|---|---|---|
| Language | Kotlin (K2 compiler) | 2.1.x |
| Build | Gradle + AGP | AGP 8.7, Gradle 8.11 |
| JDK toolchain | OpenJDK | 17 |
| minSdk / targetSdk | 23 / 35 | Android 6.0 → 15 |
| UI | Jetpack Compose + Compose Compiler Gradle plugin | Compose BOM 2025.01 |
| TV UI primitives | `androidx.tv:tv-material` | 1.0.0 |
| Navigation | `androidx.navigation:navigation-compose` | 2.8.x |
| Player | Media3 ExoPlayer + Media3 UI | 1.5.1 |
| Image loader | Coil 3 (Compose-native, OkHttp engine) | 3.0.x |
| HTTP | OkHttp | 5.0.x |
| JSON | kotlinx.serialization-json | 1.7.x |
| WebSocket | OkHttp `WebSocket` (bundled) | — |
| Coroutines | kotlinx.coroutines | 1.9.x |
| Dependency injection | Manual constructor injection | — |

**Build flags:**

- R8 full mode (AGP 8 default)
- Resource shrinking on release
- ABI split: `arm64-v8a` + `armeabi-v7a` (ISP boxes + older TVs may still be 32-bit ARM; Shield is arm64)
- Compose Compiler stability metrics emitted on release builds
- `android.nonTransitiveRClass=true`, `android.enableR8.fullMode=true`

**Player flags (applied in `PlayerScreen`):**

- `ExoPlayer.Builder.setVideoScalingMode(SCALE_TO_FIT)`
- `ExoPlayer.Builder.setSeekForwardIncrementMs(10_000)` + back increment 10s
- `ExoPlayer.setTrackSelectionParameters(Builder…setTunnelingEnabled(true))` — tunneled decode is a no-op on boxes that don't support it, so safe to always request
- `ExoPlayer.setVideoFrameRateSwitchingEnabled(ON_WITH_SEAMLESS)` — falls back to off on displays without modeset support
- Audio attributes: `C.USAGE_MEDIA` + `C.AUDIO_CONTENT_TYPE_MOVIE` + offload enabled
- Player surface: `SurfaceView` via `PlayerView` in XML (`surface_type="surface_view"`)

## Data flow

### Startup

1. `HorizonApp.onCreate` constructs `HorizonApi` with `BuildConfig.SERVER_URL` (populated at Gradle sync from `local.properties`).
2. `MainActivity` sets up `NavHost`, starts on `profile_list`.
3. `AppState.activeUser` is `null` → profile picker renders.

### Profile → Library

1. `ProfileListScreen` fetches `GET /users`, shows a vertical `LazyColumn` of names (standard Compose foundation — `tv-foundation`'s wrappers are deprecated in `tv-material 1.0.0`).
2. `onClick` on a row sets `AppState.activeUser = user`, navigates to `library`.
3. Long-press on row → delete confirmation dialog → `DELETE /users/:id`.
4. "Add profile" row at bottom → dialog with name input → `POST /users`.

### Library

1. `LibraryScreen` fetches `GET /library/movies`, `GET /library/shows`, `GET /library/collections`, `GET /progress/continue-watching?userId=…` in parallel.
2. Renders a chip row (Movies / Series / Collections), a horizontal `TvLazyRow` for Continue Watching (if non-empty), and the active-tab grid as a `TvLazyVerticalGrid`.
3. Each grid item: Coil-loaded poster (from `TmdbImage.url`) + title text below.
4. D-pad:
   - Up/Down moves between rail → chips → grid
   - Enter on a movie tile → `player/:id`
   - Enter on a show tile → `show/:id`
   - Enter on a CW tile → `player/:id?resume=true`

### Show detail

1. `ShowDetailScreen` fetches `GET /library/shows/:id`.
2. Top area: backdrop (Coil), title, overview.
3. Season pills row. Selecting a season fetches `GET /library/shows/:id/seasons/:n/episodes`.
4. Episode list: episode number + title + duration. Enter → `player/:episodeId`.

### Player

1. `PlayerScreen` reads `mediaId` + `resume` flag from nav args.
2. Fetches saved progress (`GET /progress/:userId/:mediaId`). If `positionMs > 5000 && !watched`, shows a Compose dialog overlay with two buttons: **Resume** (starts at `positionMs`) and **Start Over** (starts at 0). Default focus on Resume. If no saved progress or `resume=false`, skip the dialog.
3. `POST /sessions` with full capabilities + `startPositionMs`. Receives `sessionId`, `streamUrl`, `wsUrl`.
4. Build `MediaItem` from `streamUrl`, hand to `ExoPlayer`.
5. Open `ProgressSocket` on `wsUrl`. Every 5 s during playback send `{type: "progress", positionMs, durationMs}`.
6. Back button: `player.release()`, `socket.close()`, `DELETE /sessions/:id`, `navController.popBackStack()`.

### Capabilities detection (runtime)

Because the app now runs on anything from a KPN IPTV box to a Shield Pro, we probe the actual device at launch and send real capabilities to the server. This lives in `api/CapabilitiesProbe.kt` and runs once per process:

- **Video codecs** — walk `MediaCodecList(REGULAR_CODECS)`, collect distinct `mimeType` values for decoder entries. Map MIME to our short name (`video/avc` → `h264`, `video/hevc` → `hevc`, `video/av01` → `av1`, `video/x-vnd.on2.vp9` → `vp9`).
- **Audio codecs** — same `MediaCodecList` pass for audio decoders.
- **HDR** — `display.getHdrCapabilities().supportedHdrTypes` on the default `Display` (`WindowManager.defaultDisplay` on API 23+, `DisplayManager` fallback). Map `HDR_TYPE_HDR10` / `HDR_TYPE_HDR10_PLUS` / `HDR_TYPE_DOLBY_VISION` to `hdr10` / `hdr10plus` / `dv`. An SDR-only box sends `[]`.
- **Audio passthrough** — `AudioManager.getDevices(GET_DEVICES_OUTPUTS)` + `AudioDeviceInfo.encodings`. If an output (HDMI / S/PDIF) reports `ENCODING_E_AC3`, `ENCODING_AC3`, `ENCODING_DTS`, `ENCODING_DTS_HD`, `ENCODING_DOLBY_TRUEHD`, we advertise those audio codecs.
- **Containers** — hardcoded `["matroska", "mp4", "mkv", "ts"]` regardless of device; all Media3 extractors ship in the library.
- **maxBitrate** — `0` (no cap). The server's direct-play path handles bandwidth sanity; LAN links on these boxes can usually saturate 4K HDR HEVC anyway.

The probe caches its result as an immutable `Capabilities` object held on `AppState`. The Player screen reads it when issuing `POST /sessions`.

This means the Shield sends the full `hdr10 + hdr10plus + dv` + `truehd` + `dts` list, a Chromecast with Google TV HD sends `h264 + hevc + vp9 + hdr10 + aac`, and a KPN box sends whatever that specific firmware exposes. The server's existing decision logic then direct-plays whatever the box actually supports and transcodes the rest.

### Network security config

Plain HTTP to the LAN server. `res/xml/network_security_config.xml`:

```xml
<network-security-config>
  <base-config cleartextTrafficPermitted="true"/>
</network-security-config>
```

Referenced from `<application android:networkSecurityConfig="@xml/network_security_config">`.

## Error handling

- Network calls use `Result<T>`; failures render a plain `Text("Error: …")` on the affected screen. No retry UI, no snackbars.
- Player failures (`Player.Listener.onPlayerError`) log to Logcat and dismiss back to the previous screen.
- Session-create failure: same — render `Text` with the server's `code`+`message` and a "Back" focusable on Back button.

## Testing

- No unit tests for v1. Wireframe scope.
- Manual deploy to Shield via `adb connect <ip>:5555` + `./gradlew :app:installDebug`.
- Manual acceptance checklist (see **Success criteria** above).

## AndroidManifest

Key entries:

```xml
<uses-feature android:name="android.software.leanback" android:required="true"/>
<uses-feature android:name="android.hardware.touchscreen" android:required="false"/>

<application
    android:name=".HorizonApp"
    android:banner="@drawable/banner"
    android:icon="@mipmap/ic_launcher"
    android:label="Horizon"
    android:theme="@style/Theme.Material3.Dark.NoActionBar"
    android:networkSecurityConfig="@xml/network_security_config"
    android:isGame="false">

  <activity
      android:name=".MainActivity"
      android:exported="true"
      android:launchMode="singleTop"
      android:screenOrientation="landscape"
      android:resizeableActivity="false">
    <intent-filter>
      <action android:name="android.intent.action.MAIN"/>
      <category android:name="android.intent.category.LEANBACK_LAUNCHER"/>
    </intent-filter>
  </activity>
</application>
```

No `MAIN / LAUNCHER` filter — Leanback-only entry point keeps phones from seeing it.

## Build + deploy

```bash
# One-time pairing (Shield: Settings → Device Preferences → About → Build × 7)
adb connect <shield-ip>:5555

# From repo root
cd tv
./gradlew :app:installDebug
adb shell monkey -p network.luuk.horizontv -c android.intent.category.LEANBACK_LAUNCHER 1
```

`local.properties`:

```
sdk.dir=/Users/luuk/Library/Android/sdk
HORIZON_SERVER_URL=http://192.168.1.10:7777
```

## Dependencies on existing server

- **No server changes required for v1.**
- The client sends fuller capabilities than the Mac client does, so direct-play will succeed on more content — already supported by the existing decision logic.
- Progress WS + resume endpoints reuse the contracts already defined for web + Mac clients.

## What this spec deliberately does not cover

- Visual design language (color, type, focus ring styling, motion) — post-v1 pass
- Handheld phone/tablet layout
- Search screen + IME integration
- Live TV / ATSC / HDHomeRun tuning
- Chromecast or AirPlay-out
- User-generated playlists
- Any feature not already in the web or Mac client

These intentional omissions exist to keep the first plan small and shippable.
