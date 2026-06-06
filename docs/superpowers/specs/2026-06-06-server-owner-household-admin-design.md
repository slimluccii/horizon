# Server-Owner Cross-Household Administration — Design

**Date:** 2026-06-06
**Status:** Approved (design), pending implementation plan
**Scope:** Let a server `owner`/`admin` see and manage **all** households from the web — list every household + members, rename, invite into any, remove members, and delete a household (with a choice to delete or orphan its members) + manage orphaned profiles. Server (identity context) + web. Touches a behavioral change to `ensureHouseholds`.

## Problem

After multi-household auth shipped, a server owner has no way to **see** other households — `GET /households/me` only returns their own, and there's no list-all endpoint. New households (from `new_household` invite redemption) are invisible to the owner. The owner also can't manage other households from one place, and there's no concept of (or UI for) a profile that belongs to no household.

## Goals

- Server owner/admin: view all households + members in one web panel.
- Manage any household: rename, invite a member (join), remove a member.
- Delete a household, choosing per-delete whether to **also delete its members** or **orphan them** (keep the profiles, unassigned).
- Manage orphaned profiles: list them, move one into a household, or delete it.

## Non-goals

- Per-household library restrictions; PIN profiles.
- Changing the per-user **Household** tab (own-household management, already shipped) — this adds a *separate* admin view.
- Android/TV changes.

## Roles & access

All endpoints here require a server `owner`/`admin` principal (the box operators). A household owner manages only their own household via the existing **Household** tab. The web admin panel lives on the **Server** tab, already gated to `owner`/`admin`. The server is the real gate; client gating is convenience.

## §1 Endpoints

Identity context (`apps/server/src/contexts/identity/`).

**New repo method:** `householdRepo.list(): Household[]` — all households.

**New/changed routes:**
- `GET /households` — owner/admin. Returns `[{ id, name, ownerUserId, members: User[] }]` for every household.
- `DELETE /households/:id` — owner/admin. Body `{ deleteMembers: boolean }`:
  - `true` → cascade-delete the household **and** its member profiles + their dependent rows (sessions, watch progress, invites created_by). Transactional.
  - `false` → set members' `household_id = NULL` (orphan them), then delete the household.
  - Guard: refuse to delete the household containing the server `owner` → `409`. Unknown id → `404`.
- `GET /users/orphans` — owner/admin. Profiles with `household_id IS NULL`.
- `POST /households/:id/members` — owner/admin. Body `{ userId }`. Moves a profile (incl. an orphan) into the household (`users.setHousehold`). `404` on unknown household/user.
- `POST /invites` — **extended**: optional `householdId` for `kind:'join'`, allowed only for owner/admin, to mint a join invite into *another* household (today it hardcodes the caller's household). A household owner omitting it still targets their own.

**Reused unchanged** (already allow server-admin cross-household): `PATCH /households/:id` (rename), `DELETE /users/:id` (remove/delete a profile, incl. an orphan — `canManageUser` already lets owner/admin act on anyone).

## §2 Reconciliation — `ensureHouseholds` becomes one-shot

`ensureHouseholds(db)` currently runs on every boot and assigns **all** `household_id IS NULL` users to "Home". With intentional orphans now possible (delete-household `deleteMembers:false`), that boot sweep would silently re-adopt orphans into the server-owner's Home on the next restart.

**Change:** make `ensureHouseholds` a **one-shot migration**, guarded by a `server_meta` flag `households_backfilled` set after the first successful run. It still backfills legacy pre-household users exactly once; subsequent boots skip the sweep, so intentional orphans persist. This is safe because after first boot every user gets a household at creation/invite time — there is nothing legitimate left to backfill.

## §3 Cascade-delete mechanics

The circular FK (`households.owner_user_id` → `users.id` and `users.household_id` → `households.id`) means delete order matters. `deleteMembers:true` runs in a single transaction:
1. Null the household's `owner_user_id` (break that reference).
2. For each member: delete dependent rows (sessions, watch_progress, invites where `created_by`), then the user row. (Reuse `userRepo.delete` per member where it already handles a user's dependents; the server-owner guard means no protected user is in a deletable household.)
3. Delete the household row.

`deleteMembers:false`: in a transaction, set each member's `household_id = NULL`, null the household's `owner_user_id`, delete the household. Members become orphans.

All-or-nothing: a failure rolls back, leaving no half-deleted household.

## §4 Web — AllHouseholdsPanel

New `AllHouseholdsPanel` on the **Server** tab (already owner/admin-gated). Loads `households.all()` + `users.orphans()`.

- **Per household:** name + owner + members. Actions:
  - Rename (inline → `households.rename`).
  - Invite member → `invites.create({ kind:'join', householdId })` → shareable `/join?code=` link (reuse existing link UI).
  - Remove member → `users.delete(id)` (confirm).
  - Delete household → dialog "Delete '<name>'? It has N members." with two confirm choices: **Delete household + members** (`deleteMembers:true`) and **Keep members (unassign)** (`deleteMembers:false`), + Cancel. No delete shown for the server-owner's own household (server also guards).
- **Unassigned profiles** section (`users.orphans()`): each profile with **Move to…** (household picker → `households.addMember(id, userId)`) and **Delete** (`users.delete`).
- Reload both lists after any mutation.

SDK additions: `households.all()`, `households.remove(id, deleteMembers)`, `households.addMember(householdId, userId)`, `users.orphans()`; `invites.create` gains optional `householdId`.

## §5 Error handling

- Non-owner/admin on any admin endpoint → `403 caller-forbidden`.
- Delete own (server-owner) household → `409`; unknown household/user → `404`.
- `POST /invites` with `householdId` by non-admin → `403`.
- Cascade is transactional → no partial state.
- Web: inline errors; lists reload on success; client gating is convenience only.

## §6 Testing

**Server (vitest; unhappy-path default):**
- `householdRepo.list()` returns all households.
- `ensureHouseholds` one-shot: first run backfills + sets `households_backfilled`; a second run with a fresh null-household user is a **no-op** (orphans survive restart).
- `DELETE /households/:id`:
  - `deleteMembers:true` → household + members + their sessions/progress/invites gone.
  - `deleteMembers:false` → household gone; members survive with `household_id = NULL`.
  - server-owner's own household → `409`; non-admin → `403`; unknown → `404`.
- `GET /users/orphans` → only null-household users; admin-only.
- `POST /households/:id/members` → moves a user (incl. orphan); admin-only; `404`s.
- `POST /invites` with `householdId` → admin mints into another household; non-admin → `403`.
- Regression: update existing `ensureHouseholds` tests for the one-shot flag; server + e2e suites stay green.

**Web (vitest + testing-library):**
- AllHouseholdsPanel renders households + members + orphans.
- Delete dialog offers both modes and calls `households.remove` with the right flag.
- Move-orphan calls `addMember`; remove/delete paths; non-admin doesn't see the panel.

## Affected files

**Server:**
- `contexts/identity/infrastructure/persistence/householdRepo.ts` — `list()`; cascade/orphan delete (or a new `householdAdmin` helper).
- `contexts/identity/infrastructure/persistence/userRepo.ts` — `listOrphans()` (or query); reuse `setHousehold`/`delete`.
- `contexts/identity/domain/household.ts` — `ensureHouseholds` one-shot guard via `server_meta`.
- `contexts/identity/infrastructure/http/households.ts` — `GET /households`, `DELETE /households/:id`, `POST /households/:id/members`.
- `contexts/identity/infrastructure/http/users.ts` — `GET /users/orphans`.
- `contexts/identity/infrastructure/http/invites.ts` — optional `householdId` on `join` create.
- `index.ts` — barrel exports.
- co-located tests.

**Web:**
- `libs/sdk/src/client/client.ts` — `households.all/remove/addMember`, `users.orphans`, `invites.create` `householdId`.
- `apps/web/src/features/settings/components/AllHouseholdsPanel.tsx` (+ css, test) — new.
- `apps/web/src/features/settings/pages/Settings.tsx` — render on the Server tab.

## Downstream

Closes the household-management story: per-user Household tab (own) + server-admin all-households view (everyone the owner can see + control), including orphan cleanup.
