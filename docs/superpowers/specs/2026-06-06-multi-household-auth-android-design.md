# Multi-Household Auth (Android TV) — Design

**Date:** 2026-06-06
**Status:** Approved (design), pending implementation plan
**Scope:** The Android TV client's auth: TV pairing (+ password fallback), session token + grant, granted-profile picker, and Bearer + `X-Horizon-Profile` per request — replacing the legacy `X-Horizon-User` header. **Android only.** Server (PRs #118/#120) and web (PR #121) are done; no changes to them.

## Problem

The TV client still authenticates with `X-Horizon-User: <userId>` (no session token) and lists/creates/deletes all users freely. The server cut over to Bearer-session auth with household-scoped, grant-based act-as (`X-Horizon-Profile`). So the TV cannot authenticate against the current server — blocking real-world testing. This closes the loop: discovery (PR #117) gets the TV to the server; this spec gets it past the door.

## Goals

- Pair the TV (show a code → approved on web/phone → poll → session + granted profiles), with a password-login fallback.
- Persist the session token per saved server; relaunch straight to the granted "who's watching" picker.
- Send `Authorization: Bearer` on every request and `X-Horizon-Profile: <activeProfileId>` on per-user requests; remove `X-Horizon-User`.
- A central 401 handler that drops the token and returns to auth.

## Non-goals

- Any server or web change (all done).
- Creating/deleting profiles on the TV (web/invite managed now).
- EncryptedSharedPreferences token storage (DataStore for v1; hardening later).
- Tunneled video decode and other pre-existing post-v1 items.

## Stack

Kotlin, Jetpack Compose + tv-material, OkHttp + kotlinx-serialization (`HorizonApi`), Jetpack DataStore (discovery's `ServerStore`), Navigation-Compose. Tests: JVM unit (JUnit4 + OkHttp MockWebServer), matching the discovery package's pure-logic style.

## §1 Architecture & flow

**`HorizonApi` (api/HorizonApi.kt):**
- **Remove** `X-Horizon-User` and `setActiveUser(id)`.
- Hold `token: String?` and `activeProfileId: String?`. `exec()` adds `Authorization: Bearer <token>` whenever a token is set, and `X-Horizon-Profile: <activeProfileId>` on per-user requests.
- Map a 401 response to a typed `Unauthorized` exception (subclass of `ApiException`).
- New auth methods:
  - `pairStart(): PairStart` → `{ code, expiresAt }`
  - `pairPoll(code): PairPoll` → `Pending` or `Authed { token, user, grant: List<String>, profiles: List<Profile> }`
  - `login(name, password): Authed` → `{ token, user, ... }` (grant self-only)
  - `getGrant(): List<Profile>` ← `GET /auth/grant` (token-validity check + fresh granted profiles)
- New type `Profile { id, name, avatar }`.

**`AppState` (app/AppState.kt):**
- Existing: `serverUrl`, `api`, (drop `activeUser`).
- Add `token: String?`, `profiles: List<Profile>`, `activeProfile: Profile?`.
- `connect(url)` builds `HorizonApi` (unchanged). `authenticate(token, profiles)` sets the api's bearer + stores `profiles`. `setActiveProfile(p)` sets the api's `X-Horizon-Profile` + `activeProfile`. `signOut()` clears token/profiles/activeProfile.

**Persistence:** extend discovery's `ServerStore` (DataStore) with a `token` field keyed to the saved server's `instanceId`. Grant/profiles are NOT persisted — re-fetched via `getGrant()` each launch so they reflect web-side changes.

**Nav flow:**
```
Boot → (saved server) connect (existing discovery logic)
     → saved token? → getGrant()
         ok    → authenticate(token, profiles) → ProfilePicker
         401   → clearToken → AuthScreen
         none  → AuthScreen
     → ProfilePicker → pick → setActiveProfile → Library
no saved server → ServerPicker (existing discovery)
AuthScreen: pairing primary (show code + poll) ; "Enter password" → login fallback
401 anywhere → signOut → AuthScreen
```

New: `AuthScreen`. Reworked: `ProfileListScreen` → granted-profile picker (no add/delete). Extended: `BootScreen` (token validate), `ServerStore` (token), `HorizonApi`, `AppState`, nav graph.

## §2 AuthScreen (pairing + password fallback)

Shown when there is no valid token.

**Pairing (primary):**
- On mount: `pairStart()` → display the code large + instruction ("On your phone: Horizon → Settings → Household → Link a TV → enter this code").
- Poll `pairPoll(code)` ~every 3s: `Pending` → keep; `Authed` → `authenticate(token, profiles)` → store token → ProfilePicker.
- Code expired (410) → auto `pairStart()` again (fresh code) with a subtle "code refreshed" note.
- "Enter password instead" → password view.
- Lifecycle: the polling coroutine is cancelled on leaving the screen / switching views (DisposableEffect), mirroring discovery's `ProgressSocket` cleanup. `pairStart` network error → "couldn't reach server" + retry.

**Password fallback:**
- Fields: name + password (tv-material `OutlinedTextField`, on-screen keyboard).
- `login(name, password)` → store token; grant is self-only → `profiles = [user-as-Profile]` (or `getGrant()`), then ProfilePicker (single) → straight into it.
- Errors inline: `invalid-credentials`, `account-locked`, `rate-limited`.
- "Use a code instead" → back to pairing.

## §3 Profile picker + active-profile wiring

**ProfilePicker** (reworked `ProfileListScreen`):
- Renders `state.profiles` (granted) — name + avatar, D-pad friendly. No add/delete.
- Pick → `state.setActiveProfile(p)` → navigate Library.
- A single granted profile still renders as a one-item list (one confirm), matching the discovery picker decision.
- "Switch server" (from discovery) stays. Add "Switch profile" (re-pick within the grant, no re-auth) and "Sign out this TV" (→ `signOut()` → AuthScreen).

**Active-profile wiring (core change):**
- `exec()` always sends `Authorization: Bearer <token>`; sends `X-Horizon-Profile: <activeProfileId>` when set.
- Per-user calls use the active profile, not a free user id: `continueWatching()`, `getProgress(mediaId)`, `createSession(...)`. Where a method took a `userId`, it now uses `activeProfileId` (the path `:userId` must equal it; server enforces). Update `LibraryScreen` / `PlayerScreen` call sites (`state.activeUser.id` → `state.activeProfile.id`).
- Remove `X-Horizon-User`.

## §4 Persistence & boot

**`ServerStore`:** add `token` (per saved server, keyed by `instanceId`); `saveToken(token)` / `clearToken()`. Profiles/grant not persisted.

**Boot resolver** (extends discovery's): after the server is resolved + connected,
```
read saved token
  present → getGrant()
      ok  → authenticate(token, profiles) → ProfilePicker
      401 → clearToken → AuthScreen
  none → AuthScreen
```
`getGrant()` is both the token-validity probe and the fresh profile list (a profile removed from the grant on web simply won't appear).

## §5 Error handling

- Pairing: `pairStart` network fail → retry; `410` code expired → auto-refresh; `202` poll → keep polling.
- Login: `invalid-credentials` / `account-locked` / `rate-limited` → inline messages.
- `profile-not-granted` (active profile removed on web mid-session) → drop active profile → back to picker (no longer lists it).
- Central `401` → `Unauthorized` → `signOut()` → AuthScreen.
- No network → "couldn't reach server" + retry + "Switch server".

## §6 Testing

JVM unit (JUnit4 + MockWebServer), matching the discovery package; unhappy paths by default.
- `HorizonApi`: sends `Bearer` + `X-Horizon-Profile` (when set); omits the profile header when unset; sends **no** `X-Horizon-User`; 401 → `Unauthorized`.
- `pairPoll` parsing: `202 Pending` vs `Authed { token, profiles }`; `410` → error.
- `login`/`getGrant` happy + error-status mapping.
- Boot/auth decision logic (pure, injected probes): token-valid → picker; 401 → auth; none → auth — mirrors discovery's `BootResolverTest`.
- `ServerStore` token round-trip + clear.
- Compose screens (`AuthScreen`, picker) + NsdManager paths: build-verified only (no Robolectric in the project), as in discovery.

## Affected files (android-tv)

- `api/HorizonApi.kt` — remove `X-Horizon-User`/`setActiveUser`; add token + `X-Horizon-Profile`, `Unauthorized`, pairing/login/grant methods.
- `api/Models.kt` — `Profile`, `PairStart`, `PairPoll` (Pending|Authed), auth bodies.
- `app/AppState.kt` — token/profiles/activeProfile; `authenticate`/`setActiveProfile`/`signOut`; drop `activeUser`.
- `discovery/ServerStore.kt` — persist/clear `token`.
- `discovery/BootResolver.kt` (+ `ui/BootScreen.kt`) — token validate via `getGrant()`.
- `ui/AuthScreen.kt` (new) — pairing + password fallback.
- `ui/ProfileListScreen.kt` — granted-profile picker (no add/delete); switch-profile / sign-out.
- `ui/LibraryScreen.kt`, `ui/PlayerScreen.kt` — active profile instead of `activeUser`.
- `MainActivity.kt` / `ui/Routes.kt` — `AuthScreen` route + nav wiring; 401 → auth.
- Tests co-located in `app/src/test/.../{api,discovery}` per §6.

## Downstream

Completes the original goal: **TV app ready for real-world testing** — discover the server (PR #117), pair + authenticate against the household model (this spec), play. End-to-end pairing works because the web approval-with-grant (PR #121) is live.
