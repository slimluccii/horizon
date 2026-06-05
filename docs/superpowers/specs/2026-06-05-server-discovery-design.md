# Server Discovery — Design

**Date:** 2026-06-05
**Status:** Approved (design), pending implementation plan
**Scope:** First-run + re-launch server discovery for the Android TV client, plus
server-side identity and mDNS advertising.

## Problem

The Android TV client hardcodes the server URL at build time via
`BuildConfig.SERVER_URL` (read from `local.properties` `HORIZON_SERVER_URL`,
default `http://10.0.2.2:7777`). To get the app ready for real-world testing,
discovery must move into the app's initial setup: the user should be able to find
Horizon servers on their network without editing a build config.

## Goals

- First run: discover servers on the LAN, present a picker, connect, persist.
- Re-launch: auto-connect to the saved server; re-resolve its address if it moved.
- Switch server later without clearing app data.
- Robust across networks where mDNS multicast is unavailable (notably bridged
  Docker, the default compose deploy).

## Non-goals

- HTTPS/TLS. LAN cleartext HTTP only (existing `network_security_config` already
  permits cleartext). No change.
- Authentication. Discovery is pre-auth. Built-in auth is a separate design
  (`2026-06-01-built-in-authentication-design.md`); this design does not touch it.
- Cross-subnet sweep, custom-port sweep. See assumptions.

## Approach

Full layered discovery — three sources behind one interface:

1. **mDNS / DNS-SD** (primary where multicast works) — server advertises
   `_horizon._tcp.local`; client scans with Android `NsdManager`.
2. **Subnet sweep** (first-class fallback) — client probes `/{1..254}:7777/health`
   on its own /24.
3. **Manual entry** (always available) — user types `host[:port]`, verified via
   `/health`.

Results merge live, deduped by `instanceId`.

### Library choices

- **Server mDNS:** `bonjour-service` (pure JS, no native deps — safe for the
  multi-arch Docker build).
- **Client scan:** Android platform `NsdManager` (no dependency).

## Architecture

```
Server (Fastify)                         Android TV client
─────────────────                        ─────────────────
identity { instanceId, name, version }   ServerDiscovery (interface)
  ├─ instanceId persisted in DB            ├─ MdnsDiscovery   (NsdManager)
  └─ name = HORIZON_SERVER_NAME            ├─ SweepDiscovery  (/24 :7777 /health)
            ?? os.hostname()               └─ ManualEntry
mDNS advertise _horizon._tcp.local       ServerStore (DataStore)
  TXT: id, name, v                         └─ { instanceId, lastUrl, name }
/health → + serverName, instanceId       Boot resolver → start destination
                                         ServerPicker (Compose screen)
                                         AppState.api built AFTER a server is picked
```

## Server changes

### Identity (`apps/server/src/identity.ts`, new)

- `instanceId` — stable UUID, generated once and persisted (key/value
  `server_meta` table, or reuse the existing settings store). The re-resolve key.
  Regenerated only when absent. **Must be unique per install** — a copied DB
  would clone the id (documented caveat; dedupe collapses duplicates).
- `serverName` — `cfg.serverName ?? os.hostname()`.
- `version` — app version.
- Exposes `{ instanceId, serverName, version }`.

### Config (`apps/server/src/config.ts`)

- New `HORIZON_SERVER_NAME` (default unset → hostname).
- New `HORIZON_MDNS` boolean (default on) to disable advertising.

### `/health` (`apps/server/src/routes/health.ts`)

Add `serverName` and `instanceId` to the existing payload (additive,
backward-compatible). Doubles as the sweep probe and re-resolve verifier.

### mDNS advertise (`apps/server/src/mdns.ts`, new)

- Started after `app.listen` in `index.ts`.
- `bonjour.publish({ name: serverName, type: 'horizon', port: cfg.port,
  txt: { id: instanceId, name: serverName, v: version } })` → `_horizon._tcp.local`.
- Graceful unpublish + `bonjour.destroy()` on SIGTERM/SIGINT.
- Guarded by `HORIZON_MDNS`.

### Docker reality

mDNS multicast does **not** cross bridged Docker networks (the compose default).
Decision: **do not fight Docker.** mDNS serves bare-metal / host-network installs;
containerized servers are found via **subnet sweep + manual entry**, which are
first-class, not afterthoughts. Document `network_mode: host` as opt-in for users
who want in-container mDNS.

## Client changes

### Discovery layer (`apps/android-tv/.../discovery/`, new package)

```kotlin
data class DiscoveredServer(
    val instanceId: String?,   // null until /health probed
    val name: String,          // mDNS name, or host:port for sweep hits
    val url: String,           // http://ip:port
    val source: Source,        // Mdns | Sweep | Manual
    val version: String?,
)
```

- **MdnsDiscovery** — wraps `NsdManager.discoverServices("_horizon._tcp",
  PROTOCOL_DNS_SD)`. Resolves serialized through a queue (NsdManager cannot
  resolve concurrently pre-API 31). Holds a `WifiManager.MulticastLock` for the
  scan window, releases on close. Emits `Flow<DiscoveredServer>`; TXT yields
  name + instanceId without hitting `/health`. Emits nothing (never crashes)
  where multicast is unavailable.
- **SweepDiscovery** — reads own IPv4 + prefix via `ConnectivityManager` /
  `LinkProperties`. Sweeps **/24 only** (skip if prefix < 24). `GET
  http://x.x.x.{1..254}:7777/health` on a bounded dispatcher (~32 parallel),
  ~800ms timeout each. Parses `status:ok` + `serverName`/`instanceId`. Emits hits
  as they land.
- **ManualEntry** — user types `host[:port]`; probe `/health`. Pre-filled with
  `BuildConfig.SERVER_URL` for dev convenience. Normalizes (adds scheme, default
  port 7777).
- **Merge** — combine mDNS + sweep into a live `StateFlow<List<DiscoveredServer>>`,
  deduped by `instanceId` (mDNS entry wins — has the friendly name; sweep hit
  with matching id collapses into it; sweep-only id stays). Picker fills as
  results arrive.

### Persistence (`ServerStore`, Jetpack DataStore Preferences)

Saves `{ instanceId, lastUrl, name }`. DataStore over SharedPreferences —
coroutine/Flow-native, matches the Compose style.

### Late-bound AppState

Today `HorizonApp.onCreate` builds `AppState(api, capabilities)` eagerly from
`BuildConfig.SERVER_URL`. New shape:

- `onCreate` builds only `capabilities` (device probe, server-independent),
  `ServerStore`, and the `NsdManager` handle.
- `AppState.api` becomes late-set: `fun connect(url: String)` builds the
  `HorizonApi` and publishes it.
- `BuildConfig.SERVER_URL` demoted to manual-entry prefill only.

### Boot resolver

Runs before the NavHost picks its start destination (as a `Routes.BOOT` splash):

```
saved = store.read()
if (saved == null)            -> ServerPicker
else probe saved.lastUrl/health:
   ok && id matches           -> connect(lastUrl); ProfileList
   else run mDNS ~3s, find saved.instanceId:
        found                 -> connect(newUrl); store.update(url); ProfileList
        not found             -> ServerPicker (toast: "server <name> not found")
```

New routes: `Routes.BOOT`, `Routes.SERVER_PICKER`.

### ServerPicker UI (`ServerPickerScreen`, Compose + tv-material, D-pad friendly)

- Title "Find your Horizon server".
- Live list of `DiscoveredServer` (fills as mDNS/sweep land); row = name + url +
  source badge.
- Footer "Enter address manually" → dialog (reuse the AlertDialog +
  OutlinedTextField pattern from `ProfileListScreen.kt`).
- Spinner + "Rescan"; empty-after-scan nudges to manual.
- Always lists, even for a single result (one confirm tap).
- Pick → `state.connect(url)` + `store.save(...)` → ProfileList (popUpTo
  inclusive).

### Switch server

A "Switch server" `ListItem` on `ProfileListScreen` → `nav.navigate(SERVER_PICKER)`.

## Behavior summary (locked decisions)

| Decision | Choice |
|----------|--------|
| Discovery stack | Full layered: mDNS + sweep + manual |
| Server identity | Configurable name (`HORIZON_SERVER_NAME`), default hostname; auto instanceId |
| Re-launch | Auto-connect by instanceId; re-resolve via mDNS if moved; picker if not found |
| First-run picker | Always list, even for one server |
| Switch server | Action on ProfileList screen |
| Docker mDNS | Rely on sweep + document host-networking as opt-in |

## Assumptions (flag if wrong)

- **Sweep is /24 only.** Larger subnets rely on mDNS or manual entry.
- **Sweep probes port 7777 only.** Custom ports rely on mDNS or manual entry.
- **instanceId is unique per install.** A copied DB clones it.

## Error handling

- mDNS unavailable (no lock, emulator) → emit nothing, log, no crash.
- Sweep on non-/24 → skip, log, rely on mDNS/manual.
- No network → picker shows "No network — check connection" + Rescan.
- Saved server moved + un-resolvable → picker with toast; user re-picks; new url saved.
- Duplicate instanceId (mDNS+sweep, or cloned config) → dedupe collapses.
- Manual junk (`http://`, bad host/port) → probe fails → inline "Couldn't reach a
  Horizon server there."
- NsdManager resolve races (pre-API 31) → serialize resolves through a queue.
- Scan lifecycle → stop discovery + release multicast lock on leaving picker
  (DisposableEffect), to avoid battery/socket leaks.

## Testing

### Server (vitest)
- instanceId stable across restarts (persisted); regenerated only when absent.
- serverName: `HORIZON_SERVER_NAME` overrides hostname; hostname fallback.
- `/health` includes instanceId + serverName (happy + additive shape).
- mDNS publish + destroy/unpublish lifecycle (mock bonjour), including shutdown.

### Client (JVM unit, matching existing test style)
- merge/dedupe by instanceId (mDNS name wins; sweep-only stays) — pure function.
- sweep address enumeration from ip+prefix; /24 gate rejects < 24.
- boot resolver decision table (saved=null; ok+match; unreachable+refound;
  not-found) — pure logic over an injected probe lambda.
- ServerStore round-trip.
- manual url normalization (scheme + default port).

### Manual (on-device, documented — not unit-tested)
- NsdManager discovery + real multicast on Shield against a bare-metal server.

## Affected files

**Server:** `src/identity.ts` (new), `src/mdns.ts` (new), `src/config.ts`,
`src/routes/health.ts`, `src/index.ts`, migration/store for `server_meta`.
**Client:** `discovery/` package (new), `ServerStore` (new),
`ServerPickerScreen.kt` (new), `HorizonApp.kt`, `app/AppState.kt`,
`MainActivity.kt`, `ui/Routes.kt`, `ui/ProfileListScreen.kt`.
**Docs:** README server-name + host-networking note; client first-run flow.
