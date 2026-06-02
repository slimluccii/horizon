# Built-in authentication (username + password)

**Date:** 2026-06-01
**Status:** Approved (running implementation)
**Branch:** feat/runtime-roots-tmdb (continues) → auth work

## Problem

Horizon identifies users by a self-asserted `X-Horizon-User` header — no
passwords. Safe only on a trusted LAN; cannot be port-forwarded to the internet
like Plex/Jellyfin. We need real authentication so the server can be exposed
safely: usernames + passwords, revocable sessions, and a TV-friendly login.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Auth method | Username + password |
| Password hash | **Argon2id** via `@node-rs/argon2` (prebuilt binaries, no compile); fallback `crypto.scrypt` |
| Session token | Opaque, server-side (revocable); httpOnly cookie (web) + `Authorization: Bearer` (native) |
| Migration | **Hard cutover** — remove `X-Horizon-User`; every profile needs a password |
| TV login | Device-pairing code flow (TV shows code → approve on phone) |
| Brute-force | Per-IP + per-account rate-limit **and** progressive account lockout |
| 2FA (TOTP) | Out of scope — possible later phase |

## Non-goals

- No TOTP/2FA, no OAuth/SSO, no email (no SMTP dependency).
- No password reset by email (owner/admin resets member passwords in-app;
  owner self-reset documented via a server-side CLI/escape hatch).

## Architecture

### Data model (migration v6)
- `users` gains: `password_hash TEXT` (nullable until set),
  `password_set_at INTEGER`, `failed_attempts INTEGER NOT NULL DEFAULT 0`,
  `locked_until INTEGER`. Username = existing unique `name`.
- `sessions` (new): `id`, `token_hash TEXT NOT NULL` (SHA-256 of the opaque
  token — raw token never stored), `user_id`, `created_at`, `expires_at`,
  `last_seen_at`, `user_agent`. Sliding ~90-day expiry.
- `pairing_codes` (new): `code` (short, e.g. ABCD-1234), `created_at`,
  `expires_at` (~10 min), `approved_user_id` (null until approved),
  `consumed INTEGER NOT NULL DEFAULT 0`, `session_id` (set on approval).

### Password module (`apps/server/src/auth/password.ts`)
- `hash(password): Promise<string>` / `verify(hash, password): Promise<boolean>`
  using `@node-rs/argon2` (argon2id, sane memory/time cost). Self-contained so
  the algorithm can be swapped. Verify is deliberately ~100ms.
- Lazy fallback to `crypto.scryptSync` (parameterised, OWASP cost) only if the
  native module fails to load — logged once at boot.

### Session module (`apps/server/src/auth/session.ts`)
- `issue(userId, userAgent): { token, session }` — 32 random bytes
  (base64url); store only its SHA-256. Returns raw token once.
- `resolve(token): Session | null` — hash, look up, check expiry, bump
  `last_seen_at` (sliding). `revoke(id)` / `revokeAllForUser(userId)`.
- Periodic cleanup of expired rows (on resolve miss + a boot sweep).

### requireAuth hook (`apps/server/src/auth/middleware.ts`)
- Reads token from the `hz_session` cookie OR `Authorization: Bearer`.
  Resolves the session → attaches `req.user = { id, role }`. 401 on miss.
- Replaces `resolveCallerRole` / `X-Horizon-User` across all routes
  (~12 server files). `requireUser`/`canAccessSession` keep their role logic but
  source identity from `req.user`.
- Registered as a global `onRequest` hook with an **allowlist**: `/health`,
  `POST /auth/login`, `POST /auth/pair/start`, `POST /auth/pair/poll`, and the
  static web assets. Everything else requires a session.

### Auth routes (`apps/server/src/routes/auth.ts`)
- `POST /auth/login` `{name, password}` → verify; on success issue session, set
  `hz_session` httpOnly SameSite=Lax (Secure when proxied TLS) + return `{token, user}`
  for native clients. Rate-limited per-IP + per-account; on repeated failure
  increment `failed_attempts`, set `locked_until` (exponential: 5 fails → 1 min,
  doubling). Generic error messages (no user-enumeration).
- `POST /auth/logout` → revoke current session (clear cookie).
- `POST /auth/logout-all` → `revokeAllForUser`.
- `GET /auth/me` → `req.user` (the SDK's identity source).
- `POST /auth/set-password` → self (knows old password) OR owner/admin for
  another user (reset, no old password). First-boot owner is forced through this.
- Pairing:
  - `POST /auth/pair/start` (unauth, rate-limited) → `{code, expiresAt}`; TV displays it.
  - `POST /auth/pair/approve` `{code}` (authed phone/web) → binds `approved_user_id`.
  - `POST /auth/pair/poll` `{code}` (unauth) → `{token, user}` once approved, then mark consumed. 410 if expired/consumed.

### Media transports
- Web: the httpOnly `hz_session` cookie auto-rides `<video src>`, `<track src>`,
  and the WebSocket upgrade — so **remove the `?user=` / `?token=` query-param
  identity hack**. The per-session `reconnectToken` stays as the
  session-ownership proof on top of identity.
- Native (macOS, TV): already control headers — send `Authorization: Bearer`.

### SDK (`libs/sdk`)
- `auth.login(name, password)`, `auth.logout()`, `auth.logoutAll()`,
  `auth.me()`, `auth.setPassword(...)`, `auth.pairStart/Approve/Poll`.
- Replace `setActiveUser(headerId)` with a bearer-token store
  (`setToken`/`getToken`); web relies on the cookie, native on the token.
- `User` type gains `hasPassword: boolean`. Browse/settings/etc unchanged.

### Web
- New `/login` page: profile picker + password. `useActiveUser` calls
  `/auth/me`; any 401 → redirect to `/login`. Logout button.
- Setup wizard step 1 sets the **owner password**. Set-password screen for any
  user whose `password_set_at` is null.
- A `/link` page: enter pairing code → approve a TV.

### macOS + Android TV
- macOS: login form; store the bearer token in Keychain; attach to all requests.
- Android TV: pairing-code screen (show code + `…/link` URL, poll until approved,
  store token).

## Migration / cutover

- v6 migration adds the columns; existing owner has `password_set_at = null`.
- First boot after upgrade: owner is forced to set a password before anything
  else; owner then sets temp passwords for members (or each member self-sets on
  first login). No profile is usable without a password.
- `X-Horizon-User` is removed everywhere. All routes require a session.
- Owner lockout escape hatch: a server-side one-shot (env `HORIZON_RESET_OWNER_PASSWORD=1`
  on boot, or a small script) clears the owner's password + lockout so they can
  re-set it. Documented in DEPLOY.md.

## Security notes

- Store only token **hashes**; raw token shown once. Argon2id for passwords.
- Generic login errors (no "user not found" vs "bad password").
- Per-IP + per-account rate limit + lockout on `/auth/login` and `/auth/pair/*`.
- Cookie httpOnly + SameSite=Lax; `Secure` when `X-Forwarded-Proto=https`.
- Pairing codes short-lived, single-use, approval requires an authed user.
- This makes direct port-forwarding defensible; DEPLOY.md security banner updated
  (still recommend TLS via reverse proxy for cookie Secure + transport privacy).

## Testing

- password: hash/verify round-trip, wrong password, fallback path.
- session: issue→resolve→revoke, expiry, sliding last_seen, logout-all.
- middleware: cookie path, bearer path, 401 on missing/expired, allowlist.
- login: success, wrong password, lockout after N, per-IP 429, no enumeration.
- pairing: start→approve→poll happy path, expiry (410), double-consume (410),
  poll-before-approve (pending).
- set-password: self with old pw, owner reset of member, first-boot forced.
- every existing route: rejects with no session; update all current tests
  (header → session/bearer helper).
- web/SDK build green; docker image builds (argon2 prebuilt binary loads in the
  linux container — verify at runtime, fall back to scrypt if not).

## Rollout

One coherent feature, ~20 files. Single spec → implementation. Lands on the
auth branch; verified (typecheck + tests + web build + docker build + live
login/pairing smoke test) before merge.
