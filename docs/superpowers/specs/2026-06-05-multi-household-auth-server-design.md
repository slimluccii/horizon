# Multi-Household Auth (Server) — Design

**Date:** 2026-06-05
**Status:** Approved (design), pending implementation plan
**Scope:** Server-side household model, invites, and act-as authorization that lets one paired device serve a group of profiles while isolating other groups. **Server only** — the web management UI and the Android client are separate specs (see §6).

## Problem

The server cut over to per-user Bearer sessions, but: (a) the Android client still sends the legacy `X-Horizon-User` header and cannot authenticate; (b) there is no way to group profiles so that a shared device (living-room TV) can serve several people while keeping other people (friends) isolated from those profiles. The owner wants their own + their partner's profiles on one paired TV, friends to have server access (shared library) without seeing those profiles.

## Goals

- A **household** groups profiles that share devices and trust. Profiles, watch data, and act-as are household-scoped; the **media library stays fully shared** server-wide.
- A device, once paired, can **act as a granted set of profiles** — the set is decided at pairing approval, bounded by the approver's authority.
- **Invites** onboard new members (join an existing household) and new households (friends).
- Remove `X-Horizon-User`; introduce `X-Horizon-Profile` gated by a per-session grant.

## Non-goals (explicitly out of this spec)

- PIN-per-profile privacy within a granted set — future enhancement.
- Per-household library restrictions — library is fully shared.
- The web management UI and the Android client — separate specs (§6).
- Changing the existing unauthenticated `GET /users` behavior used by the current web login page (privacy item flagged in §3).

## Roles

Existing server roles are unchanged and **kept distinct from household membership**:

- **Server role** — `owner` / `admin` / `member` (DB `CHECK(role IN ('owner','admin','member'))`, unique index enforces one `owner`). Governs box administration: settings, scans, server-wide management. First-boot owner = server `owner`. Friends = `member`.
- **Household role** — a household has one **owner** (`households.owner_user_id`). The household owner can invite into / manage *their* household. Orthogonal to server role: a friend is server-`member` but owner of *their own* household.

Authorization split per request:
- **Principal** — the authenticated session user; drives server-role checks. `req.principal`.
- **Active profile** — whose personal data the request touches; selected via `X-Horizon-Profile`. `req.profileUserId`.

## §1 Entities

- **`households`** — `id`, `name`, `owner_user_id`, `created_at`.
- **`users.household_id`** — every user belongs to exactly one household (nullable column, backfilled at boot — §5).
- **`invites`** — `code`, `kind` (`join` | `new_household`), `household_id` (target for `join`), `created_by`, `created_at`, `expires_at`, `consumed_at`. Short-lived, single-use (mirrors pairing codes).

**Act-as primitive (grant-based):** a session may act as profile P **iff P is in the session's grant set**. The grant is captured at pairing approval (or login), not derived from shared household at request time. Friends (own household, grant = self) cannot reach other households' profiles.

## §2 Act-as authorization

A new `resolveProfile` hook runs after `requireAuth`:

1. No `X-Horizon-Profile` header → `profileUserId = principal.id`.
2. Header present → the target userId must be in `session.grant`; else `403 profile-not-granted`.
3. A null/absent grant on the session defaults to `[principal.id]` (safe fallback).

**Route usage:**
- Per-user routes (`/users/:id/continue-watching`, `/users/:id/progress/*`, `POST /sessions`, progress WS) act on `req.profileUserId`. Where these routes take a `:userId` path param, it must equal `req.profileUserId` (or be replaced by it) — the client no longer asserts identity via path/header trust.
- Admin/management routes authorize on `req.principal.role` (and household ownership where relevant).

The legacy `X-Horizon-User` header and `resolveCallerRole`-style path trust are **removed**.

## §3 Endpoints

**Invites**
- `POST /invites` — auth; household owner or server `owner`/`admin`. Body `{ kind: 'join' | 'new_household' }`. `join` targets the caller's household (server admin may target another household by id). Returns `{ code, expiresAt }`.
- `POST /invites/redeem` — **unauthenticated** (allowlisted). Body `{ code, name, password }`.
  - `join` → new user (server-role `member`) in the invite's household.
  - `new_household` → new household + new user who becomes that household's owner (server-role `member`).
  - Issues a session (with grant = `[newUser.id]`) → returns `{ token, user }`.
  - Validation: unknown → `404 invite-not-found`; expired/consumed → `410 invite-expired`; weak password → `400 weak-password` (reuse existing `MIN_PASSWORD_LEN`); duplicate name (within target household) → `409`.

**Households**
- `GET /households/me` — auth. Returns the caller's household + its members (id, name, owner, members[]). Drives management UI + picker scoping.
- `PATCH /households/:id` — rename; household owner or server `owner`/`admin`. (Minor.)
- No public `POST /households` — households are born from `new_household` redemption and first-boot Home.

**Users — scoping change**
- Authenticated `GET /users` → only the caller's household members.
- Unauthenticated `GET /users` → behavior unchanged (existing web login picker). **Privacy item:** in a multi-household world this leaks names across households; left as-is here because the Android TV never uses the pre-auth list (it pairs before listing) and changing it is web-client scope. Revisit when the web adopts households.
- User creation now flows through invite redemption + first-boot owner creation. `PATCH`/`DELETE /users` stay scoped to the caller's household and require household-owner or server `owner`/`admin`.

## §4 Pairing + grant

Extends the existing pairing endpoints.

- **`POST /auth/pair/start`** — unchanged. Returns `{ code, expiresAt }`.
- **`POST /auth/pair/approve`** — auth. Body gains optional `grant: userId[]`.
  - Validation against the approver:
    - **Household owner** → every id in `grant` must be in the approver's household; omitted ⇒ all household members.
    - **Member** → `grant` must be `[approver.id]` (or omitted ⇒ self); any other id ⇒ `403 grant-forbidden`.
  - Stores `granted_user_ids` on the pairing code alongside `approved_user_id`.
- **`POST /auth/pair/poll`** — unchanged contract. On approval, issues the session **stamped with the grant**, returns `{ token, user, grant }`, consumes the code.
- **`POST /auth/login`** (password fallback) — issues a session with grant `[user.id]` (single profile).

**Session carries the grant:** `sessions.issue(userId, userAgent, grant = [userId])` stamps `grant_user_ids` (JSON). `resolve()` returns it; `resolveProfile` enforces membership.

**Approval UX** (the grant picker — owner sees Home members with checkboxes, default all) is **web/phone-client work**; the server only accepts + validates the `grant` array. The TV never chooses its own grant.

## §5 Migration & data model

**Migration v3** (DDL only; v2 was `server_meta`):
- `households(id TEXT PK, name TEXT NOT NULL, owner_user_id TEXT REFERENCES users(id), created_at INTEGER)`.
- `users` + `household_id TEXT REFERENCES households(id)` — nullable.
- `sessions` + `grant_user_ids TEXT` (JSON; null ⇒ `[user_id]`).
- `pairing_codes` + `granted_user_ids TEXT` (JSON).
- `invites(code TEXT PK, kind TEXT CHECK(kind IN ('join','new_household')), household_id TEXT, created_by TEXT, created_at INTEGER, expires_at INTEGER, consumed_at INTEGER)`.

**Backfill in code (idempotent `ensureHouseholds(db)` at boot)** — mirrors `loadIdentity` / `bootstrapFromEnv`, avoids timestamp/UUID-in-SQL:
- If any user has `household_id IS NULL`: ensure a "Home" household exists (owner = the server `owner` user), assign all household-less users to it.

**User-creation paths set household explicitly:**
- First-boot owner creation → create Home household (owner = that user), assign.
- `invite redeem (join)` → invite's household.
- `invite redeem (new_household)` → fresh household, redeemer = owner.

Migrations stay pure-DDL (consistent with the codebase); all dynamic bootstrapping lives in one idempotent boot function.

## §6 Downstream specs (NOT built here)

This server work unblocks two follow-on specs, each with its own design → plan:

**Web management UI (spec 2 — next):** owner/admin + household-owner management in the React app:
- Households + members list, rename.
- Invite generation (`join` / `new_household`) + share/redeem screens.
- **TV pairing approval screen with grant checkboxes** (the consent UI §4 depends on) — required before the Android pairing flow is usable end-to-end.
- Gating: server-wide actions on `principal.role ∈ {owner, admin}`; per-household actions on household ownership.

**Android client (spec 3):**
- Discover → pair (show code) → poll → store `{ token, grant }` → household-scoped profile picker (filtered to grant) → `Authorization: Bearer` + `X-Horizon-Profile` per request.
- Password-login fallback (single profile); 401 → re-pair/login.
- Remove `X-Horizon-User` from `HorizonApi.kt`.

Build order: **server → web → android** (the TV pairing flow can't complete until the web approval UI exists).

## §7 Error handling

- `X-Horizon-Profile` not in session grant → `403 profile-not-granted`.
- Member grants others at approve → `403 grant-forbidden`.
- Invite unknown → `404 invite-not-found`; expired/consumed → `410 invite-expired`.
- Redeem duplicate name → `409`; weak password → `400 weak-password`.
- Act-as across households → blocked by the grant check (household mismatch is the deeper invariant).
- `GET /households/me` with no household → bootstrap guarantees one exists.

New error codes added to the SDK `ErrorCodes` enum: `PROFILE_NOT_GRANTED`, `GRANT_FORBIDDEN`, `INVITE_NOT_FOUND`, `INVITE_EXPIRED`.

## §8 Testing (vitest; unhappy-path-by-default per repo norm)

- `ensureHouseholds` — idempotent; assigns household-less users; correct owner mapping; no-op when all assigned.
- act-as: header→profile resolution; grant allows in-set; **rejects out-of-set (403)**; null grant defaults to self; principal role unaffected by active profile.
- pairing approve grant: owner grants subset + all + default-fill; member restricted to self; out-of-household id rejected.
- poll stamps grant onto the session; login stamps self-only grant.
- invites: create requires owner/admin/household-owner; redeem `join` adds to household; redeem `new_household` creates household + makes redeemer its owner; expired/consumed/unknown rejected; duplicate name rejected.
- `GET /users` authed → only same-household members.
- Regression: the existing 555 tests stay green after `X-Horizon-User` removal (route tests already authenticate via `asUser(token)`).

## Affected files (server)

- `src/db/migrations.ts` — migration v3.
- `src/households.ts` (new) — `ensureHouseholds`, household repo/queries.
- `src/repos/users.ts` — `household_id` on create/read; household-scoped list.
- `src/auth/session.ts` — `grant_user_ids` on issue/resolve; `granted_user_ids` on pairing approve/poll.
- `src/auth/middleware.ts` — `resolveProfile` hook; remove `X-Horizon-User`.
- `src/routes/auth.ts` — `grant` on approve; grant stamping on poll/login.
- `src/routes/invites.ts` (new) — create + redeem.
- `src/routes/households.ts` (new) — `GET /households/me`, `PATCH /households/:id`.
- `src/routes/users.ts`, `src/routes/progress.ts`, `src/routes/sessions.ts` — use `req.profileUserId`.
- `src/server.ts`, `src/index.ts` — register routes, wire `resolveProfile`, call `ensureHouseholds`.
- `libs/sdk` — new `ErrorCodes`; any shared types for households/invites.
- `test/*` — per §8.
