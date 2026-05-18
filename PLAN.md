# Plan for issue #12: Role on User + auto-elect owner at first profile creation

## Goal
Add a `role` column (`owner | admin | member`, default `member`) to the `users` table, auto-elect the first profile as `owner` (via migration backfill on populated DBs, via `POST /users` on empty DBs), and guard the owner row from deletion or role mutation. Setup.tsx tells the first user they're becoming the household owner so the silent promotion isn't a surprise.

## Scope
- Expected files changed: **10**
- Expected lines changed: **~340**
- Within soft caps: **no** (10 of 8 files; lines under 400)
- Justification: the slice naturally fans out across one DB migration + one schema validator + one repo + one route + one SDK type + one UI string + three test files (matching the existing one-test-per-concern convention: `db.migrate`, `repos.users`, `routes.users`) + CONTEXT.md. Each touch is tiny (1–50 lines). Folding tests together would obscure failure modes; skipping the SDK type would let `User.role` rot. Hard caps (20 / 1500) easily respected.

## Files to change
- `apps/server/src/db/migrations.ts` — add `V3_SQL` that `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member'))`, backfills oldest user as owner if none exists, and creates partial unique index `idx_users_one_owner ON users(role) WHERE role='owner'`. Append `{ version: 3, sql: V3_SQL }` to `MIGRATIONS`.
- `apps/server/src/db/rowSchemas.ts` — add `role: z.enum(['owner','admin','member'])` to `UserRowSchema`.
- `apps/server/src/repos/users.ts` — add `role: 'owner'|'admin'|'member'` to `User` interface; in `create()`, query `SELECT COUNT(*) FROM users` inside a transaction and set `role='owner'` when count is 0 else `'member'`; let the SQLite UNIQUE-index failure surface as `Error` with `code: 'owner-exists'`; in `delete()`, look up the row first and throw `code: 'owner-protected'` when `existing.role === 'owner'`; in `update()`, accept an optional `role` in `UserPatch`, and throw `code: 'role-immutable'` if `existing.role === 'owner' && patch.role !== undefined && patch.role !== 'owner'`. Map `row.role` in `rowToUser`.
- `apps/server/src/routes/users.ts` — extend `PatchBody` with `role: z.enum(['owner','admin','member']).optional()`; wrap `users.delete(...)` in try/catch and return `errorReply(reply, 403, 'owner-protected', 'Cannot delete the household owner')`; in PATCH catch, map `role-immutable` → 403 with `code: 'role-immutable'` and `owner-exists` (defensive) → 409.
- `libs/sdk/src/types.ts` — add `role: 'owner' | 'admin' | 'member'` to `User` interface (line ~165).
- `apps/web/src/pages/Setup.tsx` — replace the subtitle copy with two-line explainer: existing "Create a profile to start watching." remains, plus a new line/eyebrow such as `"This first profile becomes the household owner."` (Setup is only rendered on the empty-DB path per `App.tsx:21`).
- `apps/server/test/db.migrate.test.ts` — add cases:
  - v3 applied → `PRAGMA user_version === 3`, `role` column exists with `member` default
  - on a DB pre-populated at v2 with two users, migrating to v3 sets the older user to `owner` and the newer to `member`
  - re-running `migrate()` after v3 leaves the existing owner unchanged and version still 3
  - inserting a second row with `role='owner'` raises a SQLite UNIQUE-constraint error
- `apps/server/test/repos.users.test.ts` — add cases:
  - first `create()` on empty repo returns `role: 'owner'`
  - second `create()` returns `role: 'member'`
  - `delete()` on owner throws with `code: 'owner-protected'`; `delete()` on non-owner returns true
  - `update(ownerId, { role: 'member' })` throws with `code: 'role-immutable'`
  - `update(ownerId, { name: 'X' })` succeeds (name change unaffected)
- `apps/server/test/routes.users.test.ts` — add cases:
  - `POST /users` to empty DB → body has `role: 'owner'`
  - `POST /users` to non-empty DB → body has `role: 'member'`
  - `DELETE /users/:id` on owner → 403 with `code: 'owner-protected'`
  - `PATCH /users/:id` with `{ role: 'member' }` on owner → 403 with `code: 'role-immutable'`
- `CONTEXT.md` — under `## Library` (or a new `## Identity` section above it), add `### Role` entry: explains `owner | admin | member`, that exactly one owner exists per DB (enforced by partial unique index), auto-election on empty DB / migration backfill, and the immutability invariant. Cross-link to `apps/server/src/repos/users.ts`.

## Out of scope
- Creating `docs/adr/0001-role-on-user-row.md` (the ADR is referenced in the issue but adding it is not in the AC — see Risks below).
- Authorization checks elsewhere (no route gates on role; admin vs member only differ in this column for now).
- Changing `apps/android-tv/.../api/Models.kt` — Kotlin `Json { ignoreUnknownKeys = true }` (HorizonApi.kt:24) means a new field on the wire is silently ignored. Leave Models.kt alone.
- Migrating role logic into a separate `roles` table (the issue's ADR explicitly prefers role-on-row).
- ProfilePicker.tsx — adding a second user from the picker creates a `member` automatically; no copy change needed.

## Steps
1. Write the four failing migration tests in `apps/server/test/db.migrate.test.ts` referencing v3 + role + unique index. Run `npm run test -w apps/server -- db.migrate` to confirm red.
2. Implement `V3_SQL` and append to `MIGRATIONS` in `apps/server/src/db/migrations.ts`. Run the migrate test suite green.
3. Update `UserRowSchema` in `apps/server/src/db/rowSchemas.ts` to include `role`.
4. Write the failing repo tests in `apps/server/test/repos.users.test.ts` for owner auto-mint, owner-protected delete, role-immutable patch.
5. Update `apps/server/src/repos/users.ts`:
   - Add `role` to `User`, `UserPatch`.
   - In `create()`, wrap count + insert in a transaction (`db.exec('BEGIN'); … COMMIT`). Determine role by `SELECT COUNT(*) FROM users` returning 0. Translate SQLite UNIQUE failure on the owner index into `Error` with `code: 'owner-exists'`.
   - In `delete()`, fetch the row, throw `code: 'owner-protected'` for owner.
   - In `update()`, support optional `role` in patch, throw `code: 'role-immutable'` when existing is owner and patch.role differs from 'owner'. Persist `role` in the UPDATE SQL only when explicitly provided.
   - Update `rowToUser` to populate `role`.
6. Write the failing route tests in `apps/server/test/routes.users.test.ts` for the four route cases.
7. Update `apps/server/src/routes/users.ts`:
   - Extend `PatchBody` with optional `role` enum.
   - Wrap DELETE handler in try/catch — return 403 `owner-protected` on that code, else rethrow.
   - In PATCH catch, map `role-immutable` → 403 and `owner-exists` → 409.
8. Update `libs/sdk/src/types.ts` `User` interface with the `role` field.
9. Update `apps/web/src/pages/Setup.tsx` subtitle copy (add the "first profile = household owner" line). No logic change.
10. Update `CONTEXT.md` with the `### Role` entry and the one-owner invariant.
11. Run the full verification suite (see below).

## Tests
- **Test-first: yes.** Failing tests to write before any production change (in order):
  1. `db.migrate.test.ts` — v3 version bump, role column with default, oldest-user backfill, idempotent re-run, partial-unique-index enforcement.
  2. `repos.users.test.ts` — first-create-is-owner, second-create-is-member, delete-owner-throws-owner-protected, patch-owner-role-throws-role-immutable, patch-owner-name-still-works.
  3. `routes.users.test.ts` — POST returns role, DELETE 403 + code, PATCH 403 + code.
- All existing tests (`repos.users.test.ts`, `routes.users.test.ts`, `repos.progress.test.ts`, `routes.progress.test.ts`, `ws.progress.test.ts`) keep passing — they create users without asserting role, and first-create auto-elects to owner without breaking name/avatar/preferences assertions.

## Verification commands
- `npm run test -w apps/server`
- `npm run typecheck -w apps/server`
- `npm run typecheck -w libs/sdk`
- `npm run typecheck -w apps/web`
- `npm run lint -w apps/server` (if configured at root)
- `npm run build -w libs/sdk` (if `User` type re-export is required at build time)

## Risks / open questions
- **ADR file is referenced but missing.** `docs/adr/0001-role-on-user-row.md` is cited in the issue body, but the `docs/adr/` directory does not exist. The acceptance criteria do not list creating it. Treating as out-of-scope; flag to the issue author if they want it bundled.
- **Concurrent `POST /users` on a truly empty DB.** Two requests could each observe count=0. Mitigation: the partial unique index on `role='owner'` lets SQLite reject the second insert atomically; the loser surfaces as `owner-exists` (translated to 409 by the route). Wrapping count+insert in `BEGIN EXCLUSIVE` further serializes. Implementer should confirm SQLite mode is WAL and the transaction shape matches.
- **Backfill tie-break.** When two existing users share the same `created_at`, SQLite picks one arbitrarily; that's acceptable (and deterministic within a given DB), but worth a one-liner comment in the migration.
- **PATCH on the owner with `{ role: 'owner' }`.** The repo treats `patch.role === 'owner'` on an owner as a no-op (allowed). Reject only when the new role *differs*. This avoids surprise 403s when a caller round-trips a User object back.
- **Setup.tsx in non-empty DB edge case.** `App.tsx:21` only routes to `/setup` when no users exist, but the route remains reachable directly. The new copy assumes empty-DB context — acceptable because that's the only way to reach Setup via normal flow; manual navigation is a non-goal.
