# Horizon — Deploy & Test Guide

End-to-end instructions for two things:

1. **Deploy the Horizon server on TrueNAS via Dockge** (Plex/Jellyfin-style).
2. **Build & install the Horizon TV app on an Nvidia Shield TV Pro** for testing.

---

## Part 1 — Server on TrueNAS (Dockge)

> ### ⚠️ Security model — read this first
>
> Horizon uses a **household identity model, like Plex/Jellyfin home mode: there
> are no passwords.** A client identifies itself with an `X-Horizon-User` header
> naming a profile; the server trusts it. This means **anyone who can reach the
> port is whoever they claim to be**, including the household owner.
>
> That is fine — and intended — on a **trusted home LAN**. It is **not** safe to
> expose directly to the internet. If you want remote access, put it behind a
> reverse proxy / VPN (Tailscale, WireGuard, or an authenticating proxy such as
> Authelia/Authentik). Do **not** port-forward 7777 to the internet as-is.
>
> Keep `HORIZON_DEV_SEED` unset in production — the server refuses to boot if it
> is set together with `NODE_ENV=production` (which the image sets), because the
> seed routes wipe and reseed the database.

### Prerequisites

- TrueNAS SCALE host with the **Dockge** app installed and running.
- SSH access to the TrueNAS host (you'll need the shell to build the image and create directories).
- An existing dataset path holding your media tree (the parent directory that
  contains your movies/shows folders) and one writable dataset for app state.
  You'll pick the actual library folders later, in the web UI.
- A **TMDB API Read Access Token** if you want metadata enrichment. Get one at <https://www.themoviedb.org/settings/api>. The server runs without it; only metadata is skipped. You can also paste it into the web UI on first run instead of setting it here.

### 1. Get the source onto the NAS

SSH in and clone the repo somewhere persistent (any path works — Dockge doesn't need to manage it):

```bash
sudo mkdir -p /mnt/<pool>/apps/horizon-src
sudo chown $USER /mnt/<pool>/apps/horizon-src
git clone <this-repo-url> /mnt/<pool>/apps/horizon-src
cd /mnt/<pool>/apps/horizon-src
```

> Replace `<pool>` with your TrueNAS pool name (e.g. `tank`).

### 2. Create the persistent data directory

```bash
sudo mkdir -p /mnt/<pool>/apps/horizon/data
# 568:568 is the TrueNAS Apps user. Match this to PUID/PGID in .env.
sudo chown -R 568:568 /mnt/<pool>/apps/horizon/data
```

### 3. Build the Docker image

From the source directory on the NAS:

```bash
cd /mnt/<pool>/apps/horizon-src
docker build -f apps/server/Dockerfile -t horizon:latest .
```

> The Dockerfile lives at `apps/server/Dockerfile` but the **build context is the
> repo root** (the server is an npm workspace that depends on `libs/sdk`). The
> compose file already points at it, so `docker compose build` does the right
> thing — you only need the explicit `-f` for a manual `docker build`.

First build pulls Node + ffmpeg layers and compiles `better-sqlite3` — expect 3–8 minutes. Subsequent builds are cached.

Verify:

```bash
docker images horizon
docker run --rm horizon:latest ffmpeg -version | head -1
```

### 4. Create the Dockge stack

In the Dockge web UI:

1. Click **+ Compose** → name the stack `horizon`.
2. Paste the contents of [`docker-compose.yml`](../docker-compose.yml) into the editor.
3. In the **Environment** tab (or by adding a `.env` next to the compose file), set:

   ```env
   HORIZON_MEDIA_HOST=/mnt/<pool>/media
   HORIZON_DATA_HOST=/mnt/<pool>/apps/horizon/data
   PUID=568
   PGID=568
   HORIZON_PORT=7777
   TZ=Europe/Amsterdam
   HORIZON_TMDB_TOKEN=<your-tmdb-read-access-token>
   ```

   `HORIZON_MEDIA_HOST` is the **parent** directory that contains your movies and
   shows folders; it's mounted read-only at `/media` inside the container. You
   pick which subfolders are libraries (and tag each Movies or Shows) in the web
   UI on first run — no per-library env vars. To expose more than one media tree,
   add a second volume (e.g. `…:/media2:ro`) in the compose file and set
   `HORIZON_MEDIA_BASE=/media:/media2`.

   The TMDB token is optional here — you can also enter it in the web UI during
   first-run setup or later under Settings.

   (Full list of optional vars: see [`.env.example`](../.env.example).)

4. Click **Save** then **Start**.

### 5. Verify the server is up

```bash
curl http://<truenas-ip>:7777/health
# → {"status":"ok", ...}
```

Then open **`http://<truenas-ip>:7777`** in a browser — the web UI is bundled
into the image and served by the server itself (Plex/Jellyfin style). No separate
web container needed.

On first run a setup wizard walks you through creating the owner profile, then
**picking your library folders**: browse the mounted media tree (confined to the
base, `/media`), and tag each folder as Movies or Shows. You can also paste a
TMDB token here. Every step is skippable — skip the folders and you'll land in an
empty library with a banner pointing you to Settings to add them later.

Once you've added folders, an initial scan kicks off. Watch it finish in
Dockge → stack → logs. You should see lines like:

```
Serving web UI from /app/apps/web/dist
Horizon listening on :7777
```

### 6. Web UI — bundled by default

The web client (`apps/web`) is **built into the server image and served
same-origin** at `http://<truenas-ip>:7777`. For most people there's nothing to
do here — it's already running. CORS stays off (same-origin), which is the
secure default.

Alternatives, if you want them:

- **Run headless** (no UI, e.g. you only use native clients): set
  `HORIZON_SERVE_WEB=0` in `.env`.
- **Host the UI separately** (CDN / its own container): build it with
  `npm -w @horizon/web run build` (→ `apps/web/dist/`) and serve it from your own
  host, reverse-proxying `/library`, `/sessions` (with WebSocket upgrade),
  `/health`, `/metadata`, and `/users` to the server. If that host is a different
  origin, set `HORIZON_CORS_ORIGINS` to it.
- **Local dev against the NAS**: point the Vite dev proxy targets in
  `apps/web/vite.config.ts` at `http://<truenas-ip>:7777`, then `npm -w @horizon/web run dev`.
- **Native clients**: the macOS app (`apps/macos`) and Android TV app (Part 2)
  talk to the server directly over the LAN.

### 7. Routine ops

| Task | How |
|------|-----|
| **Update server** | `cd /mnt/<pool>/apps/horizon-src && git pull && docker build -f apps/server/Dockerfile -t horizon:latest . && (in Dockge) restart stack` |
| **View logs** | Dockge → `horizon` stack → Logs tab |
| **Re-scan library** | `curl -XPOST http://<truenas-ip>:7777/library/rescan -H "x-horizon-user: <owner-id>"` (owner/admin only). Also runs at boot and nightly at `HORIZON_SCAN_CRON_HOUR`. |
| **Reset state** | Stop stack → `rm -rf /mnt/<pool>/apps/horizon/data/*` → start stack |

### 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Container restarts in a loop, logs show `EACCES: permission denied, open '/data/horizon.db'` | `PUID:PGID` doesn't own `HORIZON_DATA_HOST` | `chown -R <PUID>:<PGID> <data dir>` |
| `Library shows 0 items` | No library folders configured yet, or media base mount empty inside container | First check you've added folders in the web UI (Settings → Library folders). Then `docker exec horizon ls /media` — should list your media tree. If empty, fix the `HORIZON_MEDIA_HOST` path. |
| `ffmpeg not found in PATH` | Image built without ffmpeg layer | Re-build; ensure no override of the runtime stage. |
| Playback stutters on Shield | Software transcode on a slow CPU | See **GPU passthrough** below, or transcode fewer renditions: `HORIZON_MAX_RENDITIONS=2`. |
| `EADDRINUSE: 7777` | Another app on the host owns 7777 | Change `HORIZON_PORT` in `.env` (host side only — internal port stays 7777). |

### 9. (Optional) GPU passthrough for hardware transcode

By default the server **auto-detects** the encoder: it test-encodes a frame with
each hardware encoder ffmpeg advertises and only uses one that actually works,
otherwise it falls back to **software (libx264/libx265)**. So a box with no GPU
passthrough safely runs on CPU — but for HEVC 4K libraries that will hammer your
CPU. To use a GPU on TrueNAS:

#### Intel iGPU (QSV)

Uncomment the `devices:` and `group_add:` blocks in `docker-compose.yml`. Requires the host kernel to expose `/dev/dri/renderD128`. Verify on the host: `ls -l /dev/dri`. Once the device is passed through, auto-detect picks QSV on its own; no force needed.

#### Nvidia GPU

Uncomment the `deploy.resources` block. Requires `nvidia-container-toolkit` on the TrueNAS host (not installed by default — TrueNAS Electric Eel and later have an Apps-level GPU toggle, otherwise install manually).

#### Forcing an encoder

Auto-detect is usually right. To override, set `HORIZON_FORCE_ENCODER` to a
**specific ffmpeg encoder name** (not a family) — e.g. `h264_nvenc`, `hevc_nvenc`,
`h264_qsv`, or `hevc_qsv`. A bare `nvenc`/`qsv` is **not** valid and silently
falls back to CPU for that codec. Forcing skips the probe, so only set it once
you've confirmed the device is passed through.

The Shield TV is the *client*, not the transcoder — its hardware does not help the server.

---

## Part 2 — Android TV app on Nvidia Shield TV Pro

The TV client is a Gradle project under [`tv/`](../tv). Build on your Mac (or any dev box with Android SDK), install over ADB to the Shield. Existing helper script: [`tv/bin/deploy-shield`](../tv/bin/deploy-shield).

### Prerequisites

- **Android Studio** Ladybug or newer (provides Android SDK 35 + platform tools). After install, open Settings → Languages & Frameworks → Android SDK and confirm SDK 35 + build-tools are present.
- **`adb`** on your shell PATH. Either install platform-tools standalone or add `~/Library/Android/sdk/platform-tools` to `PATH`.
- **JDK 17** (Android Studio bundles one). Verify: `java -version` shows 17.x.
- The Horizon server reachable on the LAN from the Shield (Part 1 done).

### 1. Enable network ADB on the Shield

On the Shield:

1. Settings → Device Preferences → About → **Build** — click 7 times until "You are now a developer" appears.
2. Settings → Device Preferences → **Developer options**:
   - Turn on **USB debugging**.
   - Turn on **Network debugging** (sometimes called *Wireless debugging* — accept the port that appears, usually 5555).
3. Note the Shield's LAN IP: Settings → Network & Internet → your network → IP address.

### 2. Configure the build with your server URL

```bash
cd tv
cp local.properties.example local.properties
```

Edit `tv/local.properties`:

```properties
sdk.dir=/Users/<you>/Library/Android/sdk
HORIZON_SERVER_URL=http://<truenas-ip>:7777
```

The URL is baked into `BuildConfig.SERVER_URL` at build time. To change it later, edit and re-deploy.

> Use the LAN IP, **not** `localhost` — the Shield is a separate device.

### 3. First-time pairing with the Shield

```bash
adb connect <shield-ip>:5555
```

A pairing dialog appears on the Shield TV — accept "Always allow from this computer". Verify:

```bash
adb devices
# → <shield-ip>:5555    device
```

If you see `unauthorized`, accept the dialog and re-run `adb devices`.

### 4. Build and install

The repo includes a one-shot helper:

```bash
cd tv
./bin/deploy-shield <shield-ip>
```

It runs `adb connect` → `./gradlew :app:installDebug` → `monkey` to launch the LEANBACK activity. First Gradle build pulls dependencies and takes a few minutes; subsequent runs are seconds.

If the script fails, the equivalent manual steps:

```bash
cd tv
adb connect <shield-ip>:5555
./gradlew :app:installDebug
adb -s <shield-ip>:5555 shell monkey -p network.luuk.horizontv -c android.intent.category.LEANBACK_LAUNCHER 1
```

### 5. Verify on the device

The Horizon icon should appear in the Shield's app row. Open it — you should see the profile picker, then your library. Tail logs from the Mac while testing:

```bash
adb -s <shield-ip>:5555 logcat -s HorizonTV:V Media3:V ExoPlayer:V
```

### 6. Iterate

Edit Kotlin → re-run `./bin/deploy-shield <shield-ip>`. Compose changes hot-recompile in seconds; only ABI/dependency changes need a full rebuild.

To uninstall:

```bash
adb -s <shield-ip>:5555 uninstall network.luuk.horizontv
```

### 7. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `adb: failed to connect to <ip>:5555` | Network debugging toggled off, or Shield rebooted. Re-enable in Developer options. |
| `INSTALL_FAILED_VERSION_DOWNGRADE` | Already installed at higher versionCode. Uninstall first (above). |
| App opens but library is empty | `BuildConfig.SERVER_URL` is wrong, or server unreachable. Re-check `local.properties`, then `adb shell curl http://<truenas-ip>:7777/health` from the Shield. |
| Playback fails with codec error | The default render path uses Media3 software fallback for unsupported tracks — check logcat (`-s ExoPlayer`) for the codec MIME type and confirm the server is producing an HLS rendition the Shield can decode. Force a lower max rendition: `HORIZON_MAX_RENDITIONS=2` on the server. |
| Gradle download stalls behind a proxy | Set `gradle.properties` proxy settings or run with `--offline` after a successful first build. |

---

## Quick reference

| Thing | Where |
|-------|-------|
| Server image | `docker build -f apps/server/Dockerfile -t horizon:latest .` (from repo root) |
| Server compose | [`docker-compose.yml`](../docker-compose.yml) |
| Server env template | [`.env.example`](../.env.example) |
| Server health | `GET http://<host>:7777/health` |
| Server data dir | `HORIZON_DATA_HOST` on host → `/data` in container |
| TV deploy | `tv/bin/deploy-shield <ip>` |
| TV server URL config | `tv/local.properties` → `HORIZON_SERVER_URL` |
| TV package id | `network.luuk.horizontv` |
