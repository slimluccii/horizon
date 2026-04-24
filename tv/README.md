# Horizon TV

Android TV / Google TV client for the Horizon media server. Targets anything
from Android 6 up — reference device is Nvidia Shield TV Pro.

## First-time setup

1. Install Android Studio Ladybug or newer.
2. Open `tv/` as a Gradle project (File → Open → pick this folder).
3. Copy `tv/local.properties.example` to `tv/local.properties` and set
   `HORIZON_SERVER_URL` to your server's LAN URL.
4. On your Shield: Settings → Device Preferences → About → Build × 7 to
   enable developer mode, then Developer options → Network debugging.
5. From your Mac:
   ```
   adb connect <shield-ip>:5555
   cd tv
   ./bin/deploy-shield
   ```

## Stack

See `docs/superpowers/specs/2026-04-24-android-tv-client-design.md`.
