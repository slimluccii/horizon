# Plan for issue #12: Role on User + auto-elect owner at first profile creation

## Goal
Add a `role` column (`owner | admin | member`, default `member`) to the `users` table, auto-elect the first profile as `owner` (via migration backfill on populated DBs, via `POST /users` on empty DBs), and guard the owner row from deletion or role mutation. Setup.tsx and the in-app profile badge surface the owner status so the silent promotion isn't a surprise and the owner can't accidentally delete themselves.

## Scope
- Expected files changed: **11**
- Expected lines changed: **~370**
- Within soft caps: **no** (11 of 8 files; lines comfortably under 400)
- Justification: the slice naturally fans out across one DB migration + one row schema + one repo + one route + one SDK type + two UI touches (Setup copy + ProfileBadgeButton owner-guard) + three test files (matching the existing one-test-per-concern convention: `db.migrate`, `repos.users`, `routes.users`) + CONTEXT.md. Each touch is tiny (1–50 lines). Folding tests together would obscure failure modes; skipping the SDK type would let `User.role` rot; leaving `ProfileBadgeButton` untouched would surface the new 403 as an unhandled rejection in the existing UI (reviewer-flagged). Hard caps (20 / 1500) easily respected.

## Files to change
- `apps/server/src/db/migrations.ts` — add `V3_SQL` that `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member'))`, backfills oldest user as owner if none exists (`UPDATE users SET role='owner' WHERE id = (SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1) AND NOT EXISTS (SELECT 1 FROM users WHERE role='owner')`), and creates partial unique index `CREATE UNIQUE INDEX idx_users_one_owner ON users(role) WHERE role='owner'`. Append `{ version: 3, sql: V3_SQL }` to `MIGRATIONS`.
- `apps/server/src/db/rowSchemas.ts` — add `role: z.enum(['owner','admin','member'])` to `UserRowSchema`.
- `apps/server/src/repos/users.ts` — add `role: 'owner'|'admin'|'member'` to `User` interface; add optional `role` to `UserPatch`; in `create()`, query `SELECT COUNT(*) AS n FROM users` first and pass `'owner'` when 0 else `'member'` into the INSERT; wrap the INSERT in `try/catch` and, if the caught error's message contains the substring `idx_users_one_owner`, throw `Error` with `code: 'owner-exists'` (otherwise rethrow so the existing `name-taken` UNIQUE on `users.name` flow is unaffected); in `delete()`, fetch row first and throw `code: 'owner-protected'` when `existing.role === 'owner'`; in `update()`, throw `code: 'role-immutable'` if `existing.role === 'owner' && patch.role !== undefined && patch.role !== 'owner'`; persist `role` in the UPDATE SQL only when `patch.role !== undefined`; map `row.role` in `rowToUser`.
- `apps/server/src/routes/users.ts` — extend `PatchBody` with `role: z.enum(['owner','admin','member']).optional()`; in POST catch, additionally map `owner-exists` → 409 with `code: 'owner-exists'`; wrap `users.delete(...)` in try/catch and return `errorReply(reply, 403, 'owner-protected', 'Cannot delete the household owner')` on that code; in PATCH catch, map `role-immutable` → 403 with `code: 'role-immutable'` and `owner-exists` → 409.
- `libs/sdk/src/types.ts` — add `role: 'owner' | 'admin' | 'member'` to `User` interface (line ~165).
- `apps/web/src/pages/Setup.tsx` — replace the subtitle (`setup__subtitle`, line 42) with a two-line explainer: keep "Create a profile to start watching." then add an explicit owner notice (e.g. a `<p className="setup__subtitle">` second line: `"You'll be the household owner — the account that can never be removed."`). No logic change; Setup is only rendered on the empty-DB path per `App.tsx` route guard.
- `apps/web/src/components/chrome/ProfileBadgeButton.tsx` — hide/disable the "Delete profile" button when `user.role === 'owner'`. Concrete: render the `<button className="pb-badge__item pb-badge__item--danger">` only when `user.role !== 'owner'`; when owner, render a disabled non-button row (or simply omit it) so the active owner cannot trigger the now-403 path. Uses the new `User.role` field from the SDK type.
- `apps/server/test/db.migrate.test.ts` — add cases (see Tests).
- `apps/server/test/repos.users.test.ts` — **amend the existing `'deletes user and returns true'` test (line 50–55)** to create *two* users and delete the *second* (non-owner) one. Then add new cases for owner-protected delete, owner-mint behaviour, and patch-owner-role rejection. See Tests.
- `apps/server/test/routes.users.test.ts` — **amend the existing `'deletes + subsequent 404'` test (line 85–94)** to create two users and delete the second. Add new cases for the four owner paths. See Tests.
- `CONTEXT.md` — under `## Library` (or a new `## Identity` section above it), add `### Role` entry: explains `owner | admin | member`, that exactly one owner exists per DB (enforced by partial unique index), auto-election on empty DB / migration backfill, immutability invariant, and the web UI consequence (owner can't self-delete from the badge menu). Cross-link to `apps/server/src/repos/users.ts`.

## Out of scope
- **Creating `docs/adr/0001-role-on-user-row.md`.** The ADR is referenced in the issue body but adding it is not in the AC. Skip; if the issue author wants it bundled, that's a follow-up.
- Authorization checks elsewhere (no route gates on role; admin vs member only differ in this column for now).
- Changing `apps/android-tv/.../api/Models.kt` — Kotlin `Json { ignoreUnknownKeys = true }` (HorizonApi.kt:24) means a new field on the wire is silently ignored; the TV client doesn't surface role anywhere yet.
- Migrating role logic into a separate `roles` table (the issue's ADR explicitly prefers role-on-row).
- ProfilePicker.tsx — adding a second user from the picker creates a `member` automatically; no copy change needed.
- Any owner-transfer flow (PATCH to promote a member to owner). The partial unique index will 409 such attempts; that's correct behaviour for this slice and a future feature, not a regression to design around now.

## Steps
1. Write the failing migration tests in `apps/server/test/db.migrate.test.ts` (cases listed below). Run `npm -w @horizon/server run test -- db.migrate` to confirm red.
2. Implement `V3_SQL` and append to `MIGRATIONS` in `apps/server/src/db/migrations.ts`. Migrate tests green.
3. Update `UserRowSchema` in `apps/server/src/db/rowSchemas.ts` to include `role`.
4. **Amend** `apps/server/test/repos.users.test.ts`:
   - Change `'deletes user and returns true'` (line 50–55): create user `A` then user `B`, delete `B` (the non-owner), assert true; assert `repo.get(B.id)` is null; assert second `repo.delete(B.id)` returns false.
   - Add new cases: first-create-is-owner, second-create-is-member, delete-owner-throws-owner-protected, patch-owner-role-throws-role-immutable, patch-owner-name-still-works, patch-owner-with-role='owner'-is-noop, patch-non-owner-with-role='owner' throws `owner-exists` (the partial unique index path surfacing through the repo).
   Run repo tests; confirm red.
5. Update `apps/server/src/repos/users.ts`:
   - Add `role: 'owner' | 'admin' | 'member'` to `User`.
   - Add `role?: 'owner' | 'admin' | 'member'` to `UserPatch`.
   - In `create()`: after the existing `nameTaken` check, run `const isFirst = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n === 0`; set `const role = isFirst ? 'owner' : 'member'`; add `role` to the INSERT column list and bind. Wrap the INSERT prepare/run in `try { ... } catch (err) { if (String((err as Error).message).includes('idx_users_one_owner')) throw Object.assign(new Error('owner-exists'), { code: 'owner-exists' }); throw err }`. This narrow check avoids mis-mapping the existing `users.name` UNIQUE failure to `owner-exists`.
   - In `delete()`: `const existing = this.get(id); if (!existing) return false; if (existing.role === 'owner') throw Object.assign(new Error('owner-protected'), { code: 'owner-protected' });` then keep the existing DELETE.
   - In `update()`: after fetching `existing`, if `patch.role !== undefined && existing.role === 'owner' && patch.role !== 'owner'`, throw `code: 'role-immutable'`. Add `role` to the UPDATE column list **only when `patch.role !== undefined`** (build the SQL conditionally, or use `COALESCE(?, role)` with `patch.role ?? null` bound — picker's choice but spell out in the implementation that an undefined patch must not overwrite the persisted role). Trust the partial unique index to surface a second-owner attempt as `owner-exists` via the same try/catch substring check.
   - Update `rowToUser` to populate `role`.
6. Repo tests green.
7. **Amend** `apps/server/test/routes.users.test.ts`:
   - Change `'deletes + subsequent 404'` (line 85–94): create user `A` then user `B`, DELETE `B`, assert 204 then 404 on subsequent GET of `B`.
   - Add: `POST /users` to empty DB → 200 body has `role: 'owner'`. `POST /users` to non-empty DB → 200 body has `role: 'member'`. `DELETE /users/:id` on owner → 403 with `code: 'owner-protected'`. `PATCH /users/:id` with `{ role: 'member' }` on owner → 403 with `code: 'role-immutable'`. `PATCH /users/:id` with `{ role: 'owner' }` on a non-owner second user → 409 with `code: 'owner-exists'`.
   Run route tests; confirm red.
8. Update `apps/server/src/routes/users.ts`:
   - Extend `PatchBody` with optional `role` enum.
   - In POST catch, add `owner-exists` → 409 mapping (defensive; race-loser path).
   - Replace the DELETE handler body with try/catch — return `errorReply(reply, 403, 'owner-protected', 'Cannot delete the household owner')` on that code, else rethrow.
   - In PATCH catch, map `role-immutable` → 403 and `owner-exists` → 409.
9. Route tests green.
10. Update `libs/sdk/src/types.ts` `User` interface with the `role` field.
11. Update `apps/web/src/pages/Setup.tsx` subtitle copy (add the "You'll be the household owner" line). No logic change.
12. Update `apps/web/src/components/chrome/ProfileBadgeButton.tsx`: gate the "Delete profile" menu item on `user.role !== 'owner'` (the active user is now typed as having `role`, since the SDK type was updated in step 10).
13. Update `CONTEXT.md` with the `### Role` entry and the one-owner invariant.
14. Run the full verification suite (see below).

## Tests
- **Test-first: yes.** Failing tests to write before any production change (in order):
  1. `apps/server/test/db.migrate.test.ts`:
     - After `migrate(db)` on a fresh DB, `PRAGMA user_version === 3`; `PRAGMA table_info(users)` includes a `role` column with default `'member'`.
     - On a DB pre-populated at v2 with two users (insert raw rows with distinct `created_at`s), after `migrate(db)` to v3 the older user has `role='owner'` and the newer has `role='member'`.
     - Re-running `migrate(db)` is a no-op: `PRAGMA user_version` still 3; the same owner; no second owner introduced.
     - Inserting a second row with `role='owner'` raises a SQLite UNIQUE-constraint error mentioning `idx_users_one_owner`.
  2. `apps/server/test/repos.users.test.ts` (after the amendment from Step 4):
     - first-create returns `role: 'owner'`.
     - second-create returns `role: 'member'`.
     - `delete()` on the owner throws with `code === 'owner-protected'`; `delete()` on a non-owner returns true.
     - `update(ownerId, { role: 'member' })` throws with `code === 'role-immutable'`.
     - `update(ownerId, { role: 'owner' })` is a no-op (returns the row, no throw).
     - `update(ownerId, { name: 'X' })` succeeds.
     - `update(memberId, { role: 'owner' })` throws with `code === 'owner-exists'` (partial-unique-index path).
  3. `apps/server/test/routes.users.test.ts` (after the amendment from Step 7):
     - `POST /users` against empty DB → 200, body `role` === `'owner'`.
     - `POST /users` against DB with one user → 200, body `role` === `'member'`.
     - `DELETE /users/:id` on owner → 403, `code === 'owner-protected'`.
     - `PATCH /users/:id` on owner with `{ role: 'member' }` → 403, `code === 'role-immutable'`.
     - `PATCH /users/:id` on non-owner with `{ role: 'owner' }` → 409, `code === 'owner-exists'`.
- **Existing tests checked:**
  - `repos.users.test.ts:50–55` (`'deletes user and returns true'`) — **must be amended** as described above; this is the one explicit breakage from the new auto-elect rule.
  - `routes.users.test.ts:85–94` (`'deletes + subsequent 404'`) — **must be amended** the same way.
  - All other server tests (`repos.progress`, `routes.progress`, `ws.progress`, etc.) create users without asserting role and don't delete them, so they continue to pass under auto-elect.
  - SDK tests don't construct `User` literals; the new required `role` field on the type doesn't cascade into test fixtures.

## Verification commands
- `npm test` *(root — runs server + sdk vitest)*
- `npm -w @horizon/server run typecheck`
- `npm -w @horizon/server run test`
- `npm -w @horizon/sdk run build` *(libs/sdk has no `typecheck` script; `build` runs `tsc` and serves the same purpose)*
- `npm -w @horizon/web run build` *(apps/web has no `typecheck` script; `build` runs `tsc && vite build` and catches type errors)*

## Risks / open questions
- **Concurrent `POST /users` on a truly empty DB.** Two requests could each observe count=0. Mitigation: the partial unique index on `role='owner'` lets SQLite reject the second insert atomically; the loser surfaces as `owner-exists` (translated to 409 by the route). The implementer should confirm SQLite is in WAL mode (it is per `db/index.ts`), but no `BEGIN EXCLUSIVE` wrapper is needed — the index is the source of truth.
- **PATCH on a non-owner with `{ role: 'owner' }`.** This would attempt to mint a second owner. The partial unique index rejects it; the existing try/catch translates that to `owner-exists` (409 via the route). This is the correct behaviour for this slice (no transfer flow yet) — flagged so the implementer does **not** add a redundant guard in `update()`. The catch in `update()` only needs the same substring check as `create()`.
- **PATCH on the owner with `{ role: 'owner' }`.** The repo treats this as a no-op (allowed). Reject only when the new role *differs*. This avoids surprise 403s when a caller round-trips a User object back.
- **Backfill tie-break.** When two existing users share the same `created_at`, the migration's `ORDER BY created_at ASC, id ASC` makes the choice deterministic. One-liner comment in the migration is fine; no code change needed.
- **Setup.tsx in non-empty DB edge case.** `App.tsx` route guard only routes to `/setup` when no users exist, but the route remains reachable directly. The new copy assumes empty-DB context — acceptable because that's the only way to reach Setup via normal flow; manual navigation is a non-goal.
- **ProfileBadgeButton when `user.role` is `undefined`.** Until the server is upgraded to v3 in dev, an active user fetched via `/users/:id` could (briefly, during the dev cycle) lack `role`. The guard should be `user.role === 'owner'` (strict equality), so an undefined role still shows the delete button — matches prior behaviour and avoids accidentally hiding delete for everyone during the migration. Spell this out in the implementation.
