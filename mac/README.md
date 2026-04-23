# Horizon — macOS native client

SwiftUI + AVKit app for the Horizon streaming server. Mirrors the web app's
navy + accent-blue design, Nunito typography, and navigation flow.

## Requirements

- **macOS 14+ (Sonoma)** — uses Swift Observation framework
- **Xcode 15+** — for `@Observable` macro + SwiftUI macro support
- A running Horizon server (default: `http://localhost:7777`)

## Open + run

```bash
cd mac
xed Package.swift       # or double-click Package.swift in Finder
```

Xcode auto-generates the project from the SwiftPM manifest. Press **⌘R** to
build and run.

To point the app at a different server:

```bash
HORIZON_SERVER_URL=http://192.168.1.42:7777 open -a Xcode Package.swift
```

(Xcode passes env vars set in the scheme — use the Edit Scheme dialog to set
`HORIZON_SERVER_URL` for the Run action.)

## Screens

| Screen            | File                                  | Parity with web |
|-------------------|---------------------------------------|-----------------|
| First-run setup   | `Views/SetupView.swift`               | `pages/Setup.tsx` |
| Profile picker    | `Views/ProfilePickerView.swift`       | `pages/ProfilePicker.tsx` |
| Library (hero + Continue Watching + grid) | `Views/LibraryView.swift` | `pages/Library.tsx` |
| Show detail       | `Views/ShowDetailView.swift`          | `pages/Show.tsx` |
| Player (AVKit + HLS) | `Views/PlayerView.swift`           | `pages/Player.tsx` |

## Architecture

- **`Services/APIClient.swift`** — HTTP client. Attaches `X-Horizon-User`
  header automatically when an active user is set. Mirrors the web SDK.
- **`Services/ProgressSocket.swift`** — `URLSessionWebSocketTask` wrapper.
  Sends `{ type: "progress", positionMs, durationMs }` every 5 s during
  playback, matching the server's WS contract.
- **`Services/HorizonClient.swift`** — `@Observable` singleton. Holds the
  active user, persists it in UserDefaults, hydrates on launch.
- **`Theme/`** — palette + typography. Navy `rgb(0,21,35)` base, accent
  `rgb(0,158,255)`. Nunito font loaded from `Resources/Fonts/`; falls back
  to SF Pro Rounded if the files aren't bundled.

## Playback

Horizon transcodes everything to **h264 + AAC over HLS** before it reaches
the client. That means AVPlayer decodes on VideoToolbox hardware with zero
CPU — no VLC / Infuse / libplacebo needed in this client.

If you want native Dolby Vision Profile 7 or TrueHD passthrough (for
direct-play of unaltered bluray remuxes), that's a separate, larger feature:
you'd route those paths around the transcoder and render via `VLCKit` or
`MobileVLCKit` instead of `AVKit`. Not wired up here.

## Fonts

Drop Nunito `.ttf` files into `Sources/Horizon/Resources/Fonts/`. Full
instructions in the `Fonts/README.md` inside that directory.
