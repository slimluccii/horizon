# Plan for issue #18: Settings page: Profiles tab + role management

## Goal
Add a **Profiles** tab to `/settings` (owner/admin only) that lists every user with an admin↔member role dropdown, and harden `PATCH /users/:id` so role changes require the caller — resolved fresh from DB via `x-horizon-user` — to be `owner` or `admin`. Owner row stays frozen client- and server-side; DELETE-owner protection is already in place from #12.

## Scope
- Expected files changed: **6**
- Expected lines changed: **~310**
- Within soft caps: **yes** (6 of 8 files; ~310 of 400 lines)

## Files to change
- `apps/server/src/routes/users.ts` — add a `resolveCallerRole(users, req)` helper that reads `req.headers['x-horizon-user']`, calls `users.get(id)` fresh on every request (no cache, per AC "next request"), and returns `{ id, role } | null`. In the PATCH handler, **only when `parse.data.role !== undefined`**, run the gate **before** `users.update`: missing/unknown caller → `badRequest(reply, 'no-user', ...)`; caller `role === 'member'` → `errorReply(reply, 403, 'caller-forbidden', 'Only owner or admin can change roles')`. Owner/admin callers fall through to the repo, which still enforces `role-immutable` and `owner-exists`. No changes to POST, GET, or DELETE.
- `apps/server/test/routes.users.test.ts` — **amend** the two existing role-PATCH cases ("PATCH owner role to member returns 403 role-immutable", "PATCH member role to owner returns 409 owner-exists") to inject `headers: { 'x-horizon-user': owner.id }`, otherwise the new gate flips them to 400. Add the six new cases listed under **Tests**. Do **not** touch the non-role PATCH cases (name + preferences merge) — they must keep passing without a header, proving the gate is role-scoped.
- `libs/sdk/src/client.ts` — extend the `users.update` body type to include `role?: 'owner' | 'admin' | 'member'`. One-line addition; runtime is unchanged (body is `JSON.stringify`d).
- `apps/web/src/pages/Settings.tsx` — (1) widen `type Tab = 'Personal'` to `'Personal' | 'Profiles'`; (2) read `const { user } = useActiveUser()` and compute `viewerCanManage = user?.role === 'owner' || user?.role === 'admin'`; (3) compute `tabs = viewerCanManage ? ['Personal', 'Profiles'] : ['Personal']`; (4) add `{activeTab === 'Profiles' && user && <ProfilesPanel viewerRole={user.role} />}` below the Personal branch; (5) co-locate `ProfilesPanel` in the same file (matches the inline pattern this file already uses). The panel loads `horizon.users.list()` into local state, renders each row as `avatar circle + name + role widget`, and wires the role widget's `onChange` to `horizon.users.update(id, { role }).then(refetch).catch(setErr)`. **Owner rows render a static "Owner" label instead of a dropdown** (matches AC "Owner row's role dropdown is disabled in the UI" and avoids any UI-visible 409 from `owner-exists`). Non-owner rows render `<select>` with options `['member', 'admin']`. A panel-wide `busy` flag disables all dropdowns while a request is in flight.
- `apps/web/src/pages/Settings.css` — add `.settings__profile-row` (flex row), `.settings__profile-avatar` (36×36 circle), `.settings__profile-name` (flex:1), `.settings__profile-role-select` (height matches `.settings__select`), `.settings__profile-role-label` (frozen owner label), `.settings__profile-row--owner`, `.settings__profile-error` (small red text). Reuse `var(--surface)`, `var(--border-hi)`, `var(--accent)`, `var(--danger)` to match the Personal tab visuals.
- `apps/e2e/profiles.spec.ts` — append two tests to the existing spec: `test('Profiles tab visible only to owner/admin')` (seed owner Alice + member Bob; assert tab is visible for Alice, hidden for Bob), and `test('admin can demote another admin')` (seed owner + two admins via API + PATCH with owner header; switch to admin1; demote admin2 via the dropdown; assert the row reflects the new role). Keep total added lines tight (~55).

## Out of scope
- Generalized auth middleware / Fastify hook. The gate lives inline in `users.ts` because it's the only route that consumes caller role today; lifting it into a hook would be premature.
- DELETE handler changes. AC says "existing behavior preserved"; DELETE-owner protection is already at the repo layer from #12. Member-can-delete-another-member is pre-existing behaviour and outside this issue.
- Repo changes (`apps/server/src/repos/users.ts`). All gating is route-level; `role-immutable` and `owner-exists` already come from the repo.
- Caller-role check on non-role PATCH (name/avatar/preferences). The AC scopes the gate to role changes; any user can still edit their own non-role fields without a header.
- Self-vs-other distinction for non-role PATCH. Not in AC; not enforced today.
- Rendering `'owner'` as a selectable option for non-owner rows. There is no transfer-ownership feature; surfacing a 409 through the UI is bad UX. Options stay `['member', 'admin']`.
- Auto-refresh of the current viewer's tab list if their own role changes mid-session. `useActiveUser` re-fetches only on `userId` change; staleness is accepted (the viewer is the editor, not typically the edited).
- Android TV — no role-aware UI on TV; `ignoreUnknownKeys = true` (HorizonApi.kt) means the new behaviour is transparent there.
- New SDK list helper. `horizon.users.list()` already returns `User[]` including `role` (from #12).

## Steps
1. **Write failing server tests first** in `apps/server/test/routes.users.test.ts` (the six new cases under **Tests** + amend the two existing role-PATCH cases to include the owner's `x-horizon-user` header). Run `npm -w @horizon/server run test -- routes.users` and confirm: amended cases green, new cases red.
2. **Implement the route gate** in `apps/server/src/routes/users.ts`:
   ```ts
   function resolveCallerRole(users: UserRepo, req: FastifyRequest):
     { id: string; role: 'owner' | 'admin' | 'member' } | null {
     const hdr = req.headers['x-horizon-user']
     const id = typeof hdr === 'string' ? hdr : null
     if (!id) return null
     const u = users.get(id)   // fresh DB read on every request
     return u ? { id: u.id, role: u.role } : null
   }
   ```
   In the PATCH handler, after `parse.success` and before the `users.update` call:
   ```ts
   if (parse.data.role !== undefined) {
     const caller = resolveCallerRole(users, req)
     if (!caller) return badRequest(reply, 'no-user', 'Missing or unknown X-Horizon-User header')
     if (caller.role === 'member') return errorReply(reply, 403, 'caller-forbidden', 'Only owner or admin can change roles')
   }
   ```
   Re-run server tests; all green.
3. **Widen the SDK type** in `libs/sdk/src/client.ts`: add `role?: 'owner' | 'admin' | 'member'` to the `users.update` body type. Run `npm -w @horizon/sdk run build`.
4. **Build the Profiles tab UI** in `apps/web/src/pages/Settings.tsx`:
   - Widen `type Tab`.
   - Read `useActiveUser()`; derive `viewerCanManage` and `tabs`.
   - Add the `activeTab === 'Profiles'` branch and co-locate `ProfilesPanel({ viewerRole })` in the same file.
   - `ProfilesPanel` owns `rows: User[]`, `busy: boolean`, `err: string | null`. Initial load via `horizon.users.list().then(setRows)`. Owner row → static "Owner" label. Non-owner row → `<select>` with options `['member','admin']`. `onChange` → `horizon.users.update(id, { role }).then(() => horizon.users.list().then(setRows)).catch(e => setErr(e.message ?? 'Failed to update role'))`. Disable all dropdowns while `busy`.
   - Reuse the existing `userColor(name)` helper if it lives in Settings.tsx; otherwise inline a small palette helper (mirrors `ProfileBadgeButton.tsx`'s palette to keep the visual identity consistent).
5. **Add CSS** in `apps/web/src/pages/Settings.css` for the row, avatar, name, dropdown, owner label, and error states (see Files section).
6. **Add Playwright tests** in `apps/e2e/profiles.spec.ts` (the two cases listed under Files).
7. **Verify** with the commands below.

## Tests
- **Test-first: yes.**
- **New cases** in `apps/server/test/routes.users.test.ts`:
  1. `PATCH role without x-horizon-user header → 400 no-user`
  2. `PATCH role with caller role=member → 403 caller-forbidden`
  3. `PATCH role with caller=member trying to promote self → 403 caller-forbidden` (header user === path user — confirms gate is on caller role, not self-vs-other)
  4. `PATCH role with caller=owner, target=admin, body={role:'member'} → 200, body.role === 'member'`
  5. `PATCH role with caller=admin (admin1), target=other admin (admin2), body={role:'member'} → 200`
  6. `PATCH role with caller=admin, target=owner, body={role:'member'} → 403 role-immutable` (verifies the caller-gate doesn't shadow the repo's owner protection)
- **Amend** the existing role-PATCH cases (lines ~127 and ~137) to include `headers: { 'x-horizon-user': owner.id }`. Keep their original assertions.
- **Do not amend** the non-role PATCH cases (`patches name`, all 7 preferences-merge cases) — they should keep passing without a header.
- **New Playwright cases** in `apps/e2e/profiles.spec.ts`:
  - `Profiles tab visible only to owner/admin` — owner sees the tab; member does not.
  - `admin can demote another admin` — admin1 demotes admin2 via the UI dropdown; row updates.
- **AC coverage map:**
  - owner cannot be demoted by an admin → server case 6
  - owner cannot be deleted → existing `DELETE owner returns 403 owner-protected` (unchanged)
  - admin can promote/demote another admin → server case 5 + e2e `admin can demote another admin`
  - member-viewers receive 403 on PATCH role → server cases 2 + 3
  - tab visibility matches server authority → e2e `Profiles tab visible only to owner/admin` (member view: no tab; member's API call would 403 from the gate)

## Verification commands
- `npm -w @horizon/server run typecheck`
- `npm -w @horizon/server run test`
- `npm -w @horizon/sdk run build`
- `npm -w @horizon/web run build`
- `npm test` *(root — runs server + sdk vitest)*

## Risks / open questions
- **Error code naming.** `caller-forbidden` matches the noun-verb shape of existing codes (`name-taken`, `owner-protected`, `role-immutable`). If a reviewer prefers `forbidden` or `role-forbidden`, it's a one-line rename in `users.ts` + one test file.
- **DELETE caller gate.** AC explicitly preserves DELETE behaviour, so no caller-role check is added there. A member can still DELETE another non-owner via the API today; that's pre-existing (#12 only added owner-protection) and outside this issue's scope. Flagging so the reviewer doesn't expect a fix bundled in.
- **Owner-self no-op (`PATCH /users/<ownerId> { role: 'owner' }`).** Repo treats this as a no-op (covered by existing tests from #12); our gate passes (caller=owner). No regression.
- **Multi-admin race.** Two admins simultaneously demote each other. SQLite serializes writes, so the second write sees the updated role of the first. End state: one admin and one member. Acceptable; AC says nothing about coordination, and the partial unique index on `role='owner'` is the only structural invariant.
- **Viewer-role UI staleness.** `useActiveUser` re-fetches only on `userId` change. If a viewer's role is changed by someone else mid-session, their Profiles tab visibility won't update until reload. AC's "next request" is server-side; this UI staleness is acceptable and matches the existing theme/preferences pattern.
- **Owner-row UX.** Rendering a frozen "Owner" label (not a disabled dropdown with an "owner" option) keeps the dropdown options to legal transitions only and avoids exposing the 409 `owner-exists` path through the UI.
