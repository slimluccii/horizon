# Plan for issue #18: Settings page: Profiles tab + role management

## Goal
Add a **Profiles** tab to `/settings` that lists every user with an editable role dropdown (admin↔member) — visible only to owner+admin viewers — and harden the server so `PATCH /users/:id { role }` requires the caller's `x-horizon-user` to currently resolve (fresh from DB) to `owner` or `admin`. Owner row stays frozen client- and server-side; DELETE-owner protection is already in place from #12.

## Scope
- Expected files changed: **6**
- Expected lines changed: **~330**
- Within soft caps: **yes** (6 of 8 files; ~330 of 400 lines)

## Files to change
- `apps/server/src/routes/users.ts` — add a `resolveCallerRole(users, req)` helper that reads `req.headers['x-horizon-user']`, calls `users.get(id)` fresh (no module-level cache; per AC), and returns `{ role: 'owner'|'admin'|'member' } | null`. In the PATCH handler, **only when `parse.data.role !== undefined`**, call the helper and: missing/unknown caller → `errorReply(reply, 400, 'no-user', 'Missing or unknown X-Horizon-User header')`; caller role `member` → `errorReply(reply, 403, 'caller-forbidden', 'Only owner or admin can change roles')`. Order: caller-gate runs **before** the `users.update(...)` call, so role-immutable / owner-exists semantics remain unchanged for authorized callers. No changes to POST, GET, DELETE (DELETE-owner protection lives in the repo already and the AC explicitly says "existing behavior preserved").
- `apps/server/test/routes.users.test.ts` — amend the two existing role-PATCH cases (`'PATCH owner role to member returns 403 role-immutable'` line ~131; `'PATCH member role to owner returns 409 owner-exists'` line ~142) to inject `headers: { 'x-horizon-user': owner.id }`, since the new gate would otherwise turn them into 400s. Add the new cases listed under **Tests** below. Do not amend the non-role PATCH cases (`patches name`, all preferences-merge cases) — they're unaffected by the gate.
- `libs/sdk/src/client.ts` — extend the `users.update` body type at line ~65 to include `role?: 'owner' | 'admin' | 'member'`. One-line type addition; runtime is unchanged because the body is `JSON.stringify`d verbatim.
- `apps/web/src/pages/Settings.tsx` — (1) widen `type Tab = 'Personal'` → `'Personal' | 'Profiles'`; (2) compute `const tabs: Tab[] = activeUser?.role === 'owner' || activeUser?.role === 'admin' ? ['Personal', 'Profiles'] : ['Personal']` using `useActiveUser().user` (already imported indirectly — bring in `useActiveUser`); (3) add a `<>{activeTab === 'Profiles' && <ProfilesPanel viewerRole={...} />}</>` branch that fetches `horizon.users.list()` on mount, renders each user as a row (avatar circle + name + role dropdown), wires `onChange` to `horizon.users.update(id, { role })` then refetches the list, and disables the dropdown when `row.role === 'owner'` **or** `viewerRole === 'admin' && row.role === 'admin'` is false (admins *can* edit other admins per AC, so the only disable rule is `row.role === 'owner'`). Show a small inline error if the PATCH rejects. Co-locate `ProfilesPanel` in this file (don't make a new component file — keeps file count down and matches the inline pattern already used for the Personal tab).
- `apps/web/src/pages/Settings.css` — add `.settings__profile-row`, `.settings__profile-avatar`, `.settings__profile-name`, `.settings__profile-role-select`, `.settings__profile-row--owner`, `.settings__profile-error` styles. Reuse `var(--surface)`, `var(--border-hi)`, `var(--accent)` etc. so it slots into the existing visual language; mirror the height/radius of `.settings__select` for the dropdown.
- `apps/e2e/profiles.spec.ts` — add a `test('Profiles tab visible only to owner/admin')` that: seeds owner Alice (first POST) + member Bob (second POST); switches to Alice via `/profiles`; navigates to `/settings`; asserts `getByRole('button', { name: 'Profiles' })` is visible; switches to Bob; navigates to `/settings`; asserts the Profiles tab is **not** visible. Add a second `test('admin can demote another admin')` that uses the API to seed owner + admin1 + admin2 (`POST /users` then `PATCH /users/:id` with `role: 'admin'` and `x-horizon-user: <ownerId>` header), switches to admin1, opens Settings → Profiles, changes admin2's dropdown to "member", and asserts the row updates. Keep total added lines tight (~60).

## Out of scope
- Adding a separate, generalized auth middleware (e.g., Fastify hook). The gate lives inline in `users.ts` because it's the only route that consumes caller role today; lifting it into a hook would be premature and break the established progress.ts pattern (also inline).
- Changing the DELETE handler. AC says "existing behavior preserved". The DELETE-owner-protected behaviour is already implemented at the repo layer (#12).
- Changing the repo (`apps/server/src/repos/users.ts`). All gating is route-level; `role-immutable` and `owner-exists` already come from the repo.
- Caller-role check on PATCH when only non-role fields are present (name/avatar/preferences). Any user is permitted to edit their own non-role fields; the AC scopes the gate to role changes specifically.
- Self-vs-other distinction for non-role PATCH (e.g., preventing a member from editing another user's name). Not in AC; existing tests don't enforce it.
- Auto-refresh of the active user's tab list when their role changes mid-session (`useActiveUser` re-fetches only on `userId` change). The AC's "next request" wording is server-side; UI staleness is a non-issue because role-changes only originate from the Profiles tab anyway, and the active user is the *editor*, not typically the *edited*.
- New SDK helper for "list users with role". `horizon.users.list()` already returns `User[]` including `role` (from #12). No SDK additions beyond the one-line type extension on `users.update`.
- Android TV — no role-aware UI on TV; the existing `Json { ignoreUnknownKeys = true }` setting (HorizonApi.kt:24) means the new role-change endpoint behaviour is transparent there. Out of scope.
- A "Members" sub-section or invite flow. The tab lists existing users and toggles their role; nothing else.

## Steps

Branch is currently 5 commits behind `origin/main` (issue #13's settings page is on main but not yet on this branch). First step is rebase/merge.

1. **Rebase the branch onto `origin/main`** so `apps/web/src/pages/Settings.tsx`, `Settings.css`, the `role: ...` field on the SDK `User` type, and the role-aware `PATCH /users/:id` route handler are all present as the starting point. Confirm `git log --oneline` shows commit `74134f9` (Settings page merge) in history.
2. **Write the failing server tests first** in `apps/server/test/routes.users.test.ts`:
   - `'PATCH role without x-horizon-user header returns 400 no-user'`
   - `'PATCH role with caller role=member returns 403 caller-forbidden'`
   - `'PATCH role with caller role=admin demoting another admin returns 200'` (seed owner + admin1 + admin2; admin1 is caller; admin2 → member)
   - `'PATCH role with caller role=admin demoting owner returns 403 role-immutable'` (caller=admin, target=owner, body={role:'member'} — verifies caller-gate passes and the repo's existing role-immutable still trips)
   - `'PATCH role with caller role=owner demoting admin returns 200'`
   - **Amend** the two existing role-PATCH tests at line ~131 and ~142 to include the owner's `x-horizon-user` header (otherwise they regress to 400). Keep their original assertions otherwise.
   Run `npm -w @horizon/server run test -- routes.users` and confirm the new cases are red and the two amended cases are still green.
3. **Implement the route gate** in `apps/server/src/routes/users.ts`:
   ```ts
   function resolveCallerRole(users: UserRepo, req: FastifyRequest):
     { id: string; role: 'owner' | 'admin' | 'member' } | null {
     const hdr = req.headers['x-horizon-user']
     const id = typeof hdr === 'string' ? hdr : null
     if (!id) return null
     const u = users.get(id)             // fresh DB read on every request — no cache
     return u ? { id: u.id, role: u.role } : null
   }
   ```
   In the PATCH handler, immediately after `parse.success` but before `users.update`, add:
   ```ts
   if (parse.data.role !== undefined) {
     const caller = resolveCallerRole(users, req)
     if (!caller) return badRequest(reply, 'no-user', 'Missing or unknown X-Horizon-User header')
     if (caller.role === 'member') {
       return errorReply(reply, 403, 'caller-forbidden', 'Only owner or admin can change roles')
     }
   }
   ```
   Run server tests; confirm all green.
4. **Add the SDK type widening** in `libs/sdk/src/client.ts` line ~65: append `; role?: 'owner' | 'admin' | 'member'` to the `update` body union. Run `npm -w @horizon/sdk run build` to confirm.
5. **Add the Profiles tab UI** in `apps/web/src/pages/Settings.tsx`:
   - Import `useActiveUser` (if not already).
   - Widen the `Tab` type to `'Personal' | 'Profiles'`.
   - Compute `tabs` as `(['Personal', ...(viewerCanManage ? ['Profiles'] as const : [])])` where `viewerCanManage = user?.role === 'owner' || user?.role === 'admin'`.
   - Below the `{activeTab === 'Personal' && (...)}` block, add `{activeTab === 'Profiles' && <ProfilesPanel viewerRole={user!.role} />}`.
   - Define `ProfilesPanel({ viewerRole })` inline in the same file: it owns `const [rows, setRows] = useState<User[]>([])`, `const [err, setErr] = useState<string | null>(null)`; loads via `horizon.users.list().then(setRows)`; for each row renders avatar circle (reuse colour-from-name logic — copy from `ProfileBadgeButton.tsx:8-14`), name, and a `<select>` of `['member','admin','owner']` (owner disabled in options for non-owner rows? — simpler: always render member+admin; show owner as a frozen text label when `row.role === 'owner'` so the dropdown is *not even rendered* for the owner row, matching AC: "Owner row's role dropdown is disabled in the UI"). Dropdown `onChange` calls `horizon.users.update(row.id, { role: newRole }).then(() => horizon.users.list().then(setRows)).catch(e => setErr(...))`. Disable the dropdown while a request is in flight (use a per-row busy state or a panel-wide `busy`).
6. **Add the matching CSS** in `apps/web/src/pages/Settings.css` (~50 lines): `.settings__profile-row` flex row, `.settings__profile-avatar` 36×36 circle, `.settings__profile-name` flex:1, `.settings__profile-role-select` height matches Personal selects, `.settings__profile-role-label` for the owner's frozen label, `.settings__profile-error` red small text.
7. **Add the Playwright e2e** in `apps/e2e/profiles.spec.ts` (tab-visibility + admin-demotes-admin — see Files section for the two tests).
8. **Verify**:
   - `npm -w @horizon/server run typecheck`
   - `npm -w @horizon/server run test`
   - `npm -w @horizon/sdk run build`
   - `npm -w @horizon/web run build`
   - `npm test` at root (server + sdk vitest)
   - Optional: `npm -w @horizon/e2e run test` if the Playwright suite is wired up locally (CI runs it; otherwise it's enough to inspect the spec for syntax).

## Tests
- **Test-first: yes.** New + amended cases in `apps/server/test/routes.users.test.ts`:
  1. `PATCH role without x-horizon-user header → 400 no-user`
  2. `PATCH role with caller role=member → 403 caller-forbidden`
  3. `PATCH role with caller=owner, target=admin, body={role:'member'} → 200, body.role === 'member'`
  4. `PATCH role with caller=admin (admin1), target=other admin (admin2), body={role:'member'} → 200`
  5. `PATCH role with caller=admin, target=owner, body={role:'member'} → 403 role-immutable` (verifies the caller-gate doesn't shadow the repo's owner protection)
  6. `PATCH role with caller=member trying to promote self → 403 caller-forbidden` (variant of #2 but where header user === path user — confirms the gate is on caller role, not on self-vs-other)
  7. **Amend** existing `'PATCH owner role to member returns 403 role-immutable'` (line ~131) and `'PATCH member role to owner returns 409 owner-exists'` (line ~142) to inject `headers: { 'x-horizon-user': <owner.id> }`.
- Non-role PATCH cases (`patches name`, all 7 preferences cases) **must not** be amended — they should continue to pass without a caller header, proving the gate is role-scoped.
- **AC coverage map:**
  - owner cannot be demoted by an admin → case #5
  - owner cannot be deleted → existing test at routes.users.test.ts:`DELETE owner returns 403 owner-protected` (unchanged)
  - admin can promote/demote another admin → case #4
  - member-viewers receive 403 on PATCH role → case #2 (and #6)
  - tab visibility gating in the UI matches server-side authority → Playwright `Profiles tab visible only to owner/admin` (member view: no tab; member's API call would 403 anyway from the gate)

## Verification commands
- `npm -w @horizon/server run typecheck`
- `npm -w @horizon/server run test`
- `npm -w @horizon/sdk run build`
- `npm -w @horizon/web run build`
- `npm test` *(root — runs server + sdk vitest)*

## Risks / open questions
- **Branch base.** This branch (`sandcastle/issue-18`) is 5 commits behind `origin/main`. The Settings page (#13) is on main but not yet here. Step 1 is a rebase/merge; without it, `apps/web/src/pages/Settings.tsx` doesn't exist and the plan's "extend the Tab type" step has nothing to extend. Confirm with `git merge-base HEAD origin/main` before starting.
- **Caller-gate code naming.** The chosen error code is `caller-forbidden`. Existing codes in errors.ts / users.ts are noun-then-verb (`name-taken`, `owner-protected`, `role-immutable`). `caller-forbidden` matches that shape. If the reviewer prefers `forbidden` or `role-forbidden`, that's a trivial rename across one route and one test file — no semantic difference.
- **DELETE caller gate.** AC explicitly says "existing behavior preserved" for DELETE, so we add no caller-role gate there. This means a member could currently DELETE another non-owner user via the API. That's pre-existing behaviour (#12 only added owner-protection); flagging here so the reviewer doesn't expect a fix bundled in. If the reviewer wants member-can-delete-other-members closed, that's a separate ticket.
- **Owner-self editing role.** What if owner sends `PATCH /users/<ownerId> { role: 'owner' }` (a no-op)? The repo treats this as a no-op (verified by an existing test from #12) and our gate passes (caller=owner). No regression.
- **Multiple-admin race.** Two admins simultaneously try to demote each other to member. Both succeed in some order. SQLite is serialized for writes, so the second write reads the updated role of the first. End state: one admin and one member. This is acceptable; the AC says nothing about coordination, and the partial-unique-index on `role='owner'` is the only structural invariant.
- **`viewerRole` staleness in the UI.** `useActiveUser` only re-fetches on `userId` change. If a viewer's role changes via another tab/device while their tab is open, the Profiles tab visibility won't update until next reload. The AC's "next request" language is server-side; this UI staleness is a known, accepted limitation and matches the existing pattern for theme/preferences. No mitigation needed for this slice.
- **Owner option in the role dropdown.** We do **not** render `'owner'` as a selectable option for non-owner rows. Attempting to mint a second owner would 409 server-side (existing `owner-exists` from #12), but a dropdown that visibly fails is bad UX. Keeping the dropdown options to `['member', 'admin']` reflects the actual transfer-flow gap (no transfer feature yet) and avoids surfacing 409s through the UI.
