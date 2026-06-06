# Multi-Household Auth (Web) — Design

**Date:** 2026-06-06
**Status:** Approved (design), pending implementation plan
**Scope:** The web (React) management UI for the multi-household auth model — household members + rename, invite generate/redeem, and TV pairing approval with grant selection. **Web only.** The server (PRs #118/#120) already exposes every endpoint this consumes; no server changes. The Android client is a separate spec.

## Problem

The server supports households, invites, and grant-based act-as, but the web app only has a pre-grant pairing-approval screen (`Link.tsx` calls `auth.pairApprove(code)` with no grant) and no household/invite management. Without the web UI, an owner cannot approve a TV with a chosen profile set, grow their household, or onboard a friend — which blocks the Android pairing flow end-to-end.

## Goals

- Approve a TV pairing **with a grant** (which Home profiles that device may act as).
- Manage the household from Settings: see members, rename (owner), remove members (owner).
- Generate invites (`join` for household owners, `new_household` for server owner/admin) and share them as links.
- Let an invited friend/partner redeem a link to create their account and land logged-in.

## Non-goals

- No new/changed server endpoints — all exist (`/households/me`, `PATCH /households/:id`, `/invites`, `/invites/redeem`, `/auth/pair/approve` with `grant`, `DELETE /users/:id`).
- PIN-per-profile, per-household library restrictions.
- The unauthenticated pre-login `GET /users` picker privacy item (deferred in the server spec) is untouched.
- The Android client (separate spec).

## Stack

React 18 + react-router-dom v6, Vite, feature-based `src/features/*`, shared `@horizon/sdk` client (`horizon` singleton), `useActiveUser` hook (session-cookie identity; exposes `role` + `householdId`). Tests: vitest + @testing-library/react.

## §1 Architecture

Server already complete → web work is **SDK methods + UI surfacing**.

**SDK (`libs/sdk/src/client/client.ts`)** — new methods + types:
- `households.me(): Promise<HouseholdView>` — `{ id, name, ownerUserId, members: User[] }` ← `GET /households/me`
- `households.rename(id: string, name: string): Promise<HouseholdView>` ← `PATCH /households/:id`
- `invites.create(body: { kind: 'join' | 'new_household' }): Promise<{ code: string; expiresAt: number }>` ← `POST /invites`
- `invites.redeem(body: { code: string; name: string; password: string }): Promise<AuthSession>` ← `POST /invites/redeem` (unauthenticated; sets `hz_session` cookie + returns token)
- `auth.pairApprove(code: string, grant?: string[])` — **add** the optional `grant` body field
- `users.remove(id: string): Promise<void>` ← `DELETE /users/:id` (add if absent)

**Web — three surfaces:**
1. `features/settings` → new `HouseholdPanel` rendered in `Settings.tsx`.
2. `features/identity/pages/Link.tsx` — extend with grant selection.
3. `features/identity/pages/Redeem.tsx` (new) + `/join` route.

**Auth/role state:** `useActiveUser` gives the active `User` (`role`, `householdId`). `households.me()` gives `ownerUserId`. Derive: `isHouseholdOwner = me.id === household.ownerUserId`, `isServerAdmin = role === 'owner' || role === 'admin'`.

## §2 Settings → Household panel

`HouseholdPanel` (new component) rendered as a `settings__section` in `Settings.tsx`, following the existing `settings__section-title` pattern. Loads `households.me()` on mount.

- **All members:** household name + member list (name, avatar, role badge) from `households.me().members`.
- **Household owner only** (`me.id === household.ownerUserId`):
  - Rename household (inline edit → `households.rename`).
  - Remove member per row — excluded for self and the household owner; confirm dialog → `users.remove(id)`.
  - Generate `join` invite → `invites.create({ kind: 'join' })` → share link (§4).
- **Server owner/admin** (`role ∈ {owner, admin}`):
  - Generate `new_household` invite → share link.

Client gating is convenience; the server is the real gate (403 → inline error). The existing **Profiles** section (server-role change + password reset) stays unchanged; the Household panel is the household-scoped counterpart — no overlap.

## §3 Pairing approval — grant selection (Link.tsx)

Extend `Link.tsx` (keeps `formatCode`, busy/error/done states).

- Type the TV code (unchanged).
- On "Link":
  - **Household owner:** fetch `households.me()`, render members as a checklist (all checked by default); user may uncheck. Require ≥1 checked. → `pairApprove(code, selectedIds)`.
  - **Plain member:** no checklist → `pairApprove(code)` (grant omitted; server grants self only).
- Success → existing "TV linked" `done` state.

The checklist is exactly `households.me().members` (the grant must be a household subset). Server re-validates (`grant-forbidden`) so a tampered list fails closed.

## §4 Invite link + Redeem page

**Share link:** from `invites.create` → build `${location.origin}/join?code=${code}`; show with a copy button, the raw code (manual fallback), and expiry ("expires in 24h"). `new_household` link → friend; `join` link → household member.

**Redeem page** — new route `/join` (`Redeem.tsx`), **unauthenticated** (reachable with no session; Guard must not bounce it):
- Read `?code=` → prefill (normalized like `formatCode`); editable.
- Form: code, display name, password + confirm (client min 8, mirroring server `MIN_PASSWORD_LEN`).
- Submit → `invites.redeem({ code, name, password })` → server creates user + session (cookie + token).
- Success → refresh `useActiveUser` (re-run `me()`) → navigate `/` (library), authenticated.

**Routing:** register `/join` as a public route alongside `/login`, `/setup`; exclude from the auth Guard redirect.

## §5 Error handling

Surface server codes inline; never crash. Client gating is convenience — server 403/409/410 are authoritative.
- Household load fail → "couldn't load household"; `caller-forbidden` → hide action / inline "not allowed".
- Remove member: confirm dialog; `owner-protected` / `caller-forbidden` → inline error, row unchanged.
- Pairing approve: keep generic "invalid/expired"; add `grant-forbidden` → "can't grant those profiles".
- Redeem: `invite-not-found` → "invalid"; `invite-expired` → "expired — ask for a new one"; `name-taken` → "name taken, try another"; `weak-password` → "use at least 8 characters"; `rate-limited` → "too many attempts, wait a moment".

## §6 Testing

vitest + @testing-library/react, matching existing web tests; unhappy paths covered by default.
- **SDK** (`client.test.ts`): `households.me`/`rename`, `invites.create`/`redeem`, `pairApprove` includes `grant` when passed and omits it when not; error-status → thrown error mapping.
- **HouseholdPanel**: owner sees rename/remove/invite controls; non-owner sees read-only; remove confirm + `caller-forbidden` path; rename happy + error.
- **Link grant**: owner renders member checklist (default all), submits selected ids; member path omits grant; ≥1-checked guard.
- **Redeem**: prefill from `?code`; happy redeem navigates to `/`; each error code → its message; weak-password client guard.
- **Routing**: `/join` reachable unauthenticated (Guard does not redirect it).

## Affected files (web + sdk)

- `libs/sdk/src/client/client.ts` — `households`, `invites` namespaces; `auth.pairApprove(code, grant?)`; `users.remove`; types (`HouseholdView`).
- `libs/sdk/src/client/client.test.ts` — new method tests.
- `apps/web/src/features/settings/components/HouseholdPanel.tsx` (+ `.css`, `.test.tsx`) — new.
- `apps/web/src/features/settings/pages/Settings.tsx` — render `HouseholdPanel`.
- `apps/web/src/features/identity/pages/Link.tsx` (+ test) — grant selection.
- `apps/web/src/features/identity/pages/Redeem.tsx` (+ `.css`, `.test.tsx`) — new.
- `apps/web/src/shared/App.tsx` — add public `/join` route; Guard exclusion.
- `apps/web/src/features/identity/hooks/useActiveUser.ts` — expose a refresh helper if not already (for post-redeem reload).

## Downstream

Unblocks the **Android client spec** (spec 3): with web pairing-approval-with-grant in place, a TV can be paired end-to-end (TV shows code → owner approves + picks profiles on web/phone → TV polls → session + granted profiles).
