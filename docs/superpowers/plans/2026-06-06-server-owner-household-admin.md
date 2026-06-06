# Server-Owner Cross-Household Administration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a server owner/admin list and manage all households from the web — view all, rename, invite into any, remove members, delete a household (cascade or orphan its members), and manage orphaned profiles.

**Architecture:** New list/delete/move endpoints in the identity context (reusing rename + member-delete which already allow server-admin cross-household), a one-shot guard on `ensureHouseholds` so intentional orphans survive restart, plus SDK methods and an `AllHouseholdsPanel` on the web Server tab.

**Tech Stack:** Fastify, better-sqlite3 (`DatabaseSync`), zod, vitest; React 18 + `@horizon/sdk`, @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-06-06-server-owner-household-admin-design.md`

**Conventions (verified):**
- Routes in `apps/server/src/contexts/identity/infrastructure/http/`; repos in `.../persistence/`; `registerHouseholds(app, { users, households })` already mounted by `server.ts` under `/api` (behind `requireAuth` + `resolveProfile`). `req.user = { id, role }`.
- Error helpers `errorReply`/`badRequest`/`sendNotFound` from `platform/http/errors.ts`; `ErrorCodes` from `@horizon/sdk`.
- `server_meta` is a `(key, value)` KV table; read/write pattern in `platform/identity/identity.ts`.
- FK facts (migrations.ts): `sessions.user_id`, `watch_progress.user_id`, `pairing_codes.approved_user_id` are **ON DELETE CASCADE**; `invites.created_by`, `invites.household_id`, `households.owner_user_id`, `users.household_id` are **NOT** cascade — handle explicitly.
- `userRepo.delete(id)` throws `OWNER_PROTECTED` for the server `owner`; `userRepo.setHousehold(id, hid)` exists; `userRepo.listByHousehold(hid)` exists.
- better-sqlite3 transaction: `db.transaction(fn)()` (sync).
- Server tests: `openDatabase(':memory:')` + `migrate(db)`; routes via Fastify `app.inject` with `makeRequireAuth` + a bearer from `sessions.issue`. SDK tests: `spyFetch`. Web: `render` + spy on `horizon`.
- Run: server `cd apps/server && npx vitest run`, `npx tsc --noEmit`; sdk `cd libs/sdk && npx vitest run`; web `cd apps/web && npx vitest run && npx tsc --noEmit`.

**Out of scope:** library restrictions, PIN, Android.

---

## File structure

**Server (`apps/server/src/contexts/identity/`)**
- `infrastructure/persistence/householdRepo.ts` — `list()`, `deleteCascade(id)`, `deleteOrphaning(id)`, `hasServerOwner(id)`.
- `infrastructure/persistence/userRepo.ts` — `listOrphans()`.
- `domain/household.ts` — one-shot `ensureHouseholds` (server_meta flag).
- `infrastructure/http/households.ts` — `GET /households`, `DELETE /households/:id`, `POST /households/:id/members`.
- `infrastructure/http/users.ts` — `GET /users/orphans`.
- `infrastructure/http/invites.ts` — optional `householdId` on `join` create.

**Shared/web**
- `libs/sdk/src/client/client.ts` — `households.all/remove/addMember`, `users.orphans`, `invites.create` `householdId`.
- `apps/web/src/features/settings/components/AllHouseholdsPanel.tsx` (+ `.css`, `.test.tsx`).
- `apps/web/src/features/settings/pages/Settings.tsx` — render on Server tab.

---

# Phase 1 — Server repos & domain

### Task 1: householdRepo.list()

**Files:** Modify `householdRepo.ts`; Test `householdRepo.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `householdRepo.test.ts`:

```typescript
it('list() returns all households', () => {
  repo.create('A', null); repo.create('B', null)
  expect(repo.list().map(h => h.name).sort()).toEqual(['A', 'B'])
})
```

- [ ] **Step 2: Run** `cd apps/server && npx vitest run src/contexts/identity/infrastructure/persistence/householdRepo.test.ts` → FAIL (`list` missing).

- [ ] **Step 3: Implement** — add to the `HouseholdRepo` interface `list(): Household[]` and to the returned object:

```typescript
    list() {
      return (db.prepare('SELECT * FROM households ORDER BY created_at, rowid').all()).map(rowToHousehold)
    },
```

- [ ] **Step 4: Run** the test → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/contexts/identity/infrastructure/persistence/householdRepo.ts apps/server/src/contexts/identity/infrastructure/persistence/householdRepo.test.ts
git commit -m "feat(server): householdRepo.list()"
```

---

### Task 2: householdRepo delete (cascade / orphan) + owner guard

**Files:** Modify `householdRepo.ts`; Test `householdRepo.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { createUserRepo } from './userRepo.ts'
import { createSessionRepo } from './sessionRepo.ts'

it('deleteCascade removes the household, its members, and their dependent rows', () => {
  const users = createUserRepo(db)
  const sessions = createSessionRepo(db)
  const h = repo.create('Friends', null)
  const u = users.create({ name: 'F1', householdId: h.id })
  repo.setOwner(h.id, u.id)
  sessions.issue(u.id)   // a dependent row (ON DELETE CASCADE)
  expect(repo.deleteCascade(h.id)).toBe(true)
  expect(repo.get(h.id)).toBeNull()
  expect(users.get(u.id)).toBeNull()
})

it('deleteOrphaning removes the household but keeps members (household_id null)', () => {
  const users = createUserRepo(db)
  const h = repo.create('Friends', null)
  const u = users.create({ name: 'F2', householdId: h.id })
  repo.setOwner(h.id, u.id)
  expect(repo.deleteOrphaning(h.id)).toBe(true)
  expect(repo.get(h.id)).toBeNull()
  expect(users.get(u.id)?.householdId).toBeNull()
})

it('hasServerOwner is true when a role=owner user is in the household', () => {
  const users = createUserRepo(db)
  const owner = users.create({ name: 'Owner' })   // first user → owner
  const h = repo.create('Home', owner.id)
  users.setHousehold(owner.id, h.id)
  expect(repo.hasServerOwner(h.id)).toBe(true)
  expect(repo.hasServerOwner(repo.create('X', null).id)).toBe(false)
})
```

- [ ] **Step 2: Run** the file → FAIL (`deleteCascade`/`deleteOrphaning`/`hasServerOwner` missing).

- [ ] **Step 3: Implement** — add to the interface:

```typescript
  /** True if the household contains the server `owner` (must never be deleted). */
  hasServerOwner(id: string): boolean
  /** Delete the household AND its member users + their non-cascading dependents
   *  (invites). Returns false if the household doesn't exist. Transactional. */
  deleteCascade(id: string): boolean
  /** Delete the household, orphaning its members (household_id → null). Transactional. */
  deleteOrphaning(id: string): boolean
```

And to the returned object:

```typescript
    hasServerOwner(id) {
      return !!db.prepare("SELECT 1 FROM users WHERE household_id = ? AND role = 'owner' LIMIT 1").get(id)
    },
    deleteCascade(id) {
      if (!db.prepare('SELECT 1 FROM households WHERE id = ?').get(id)) return false
      db.transaction(() => {
        const members = (db.prepare('SELECT id FROM users WHERE household_id = ?').all(id) as { id: string }[])
        // Break the circular owner ref so the owner user can be deleted.
        db.prepare('UPDATE households SET owner_user_id = NULL WHERE id = ?').run(id)
        for (const m of members) {
          // invites.created_by has no ON DELETE CASCADE — clear them first.
          db.prepare('DELETE FROM invites WHERE created_by = ?').run(m.id)
          // sessions / watch_progress / pairing_codes cascade on user delete.
          db.prepare('DELETE FROM users WHERE id = ?').run(m.id)
        }
        // Invites targeting this household (FK household_id, no cascade).
        db.prepare('DELETE FROM invites WHERE household_id = ?').run(id)
        db.prepare('DELETE FROM households WHERE id = ?').run(id)
      })()
      return true
    },
    deleteOrphaning(id) {
      if (!db.prepare('SELECT 1 FROM households WHERE id = ?').get(id)) return false
      db.transaction(() => {
        db.prepare('UPDATE users SET household_id = NULL WHERE household_id = ?').run(id)
        db.prepare('UPDATE households SET owner_user_id = NULL WHERE id = ?').run(id)
        db.prepare('DELETE FROM invites WHERE household_id = ?').run(id)
        db.prepare('DELETE FROM households WHERE id = ?').run(id)
      })()
      return true
    },
```

- [ ] **Step 4: Run** the file → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/contexts/identity/infrastructure/persistence/householdRepo.ts apps/server/src/contexts/identity/infrastructure/persistence/householdRepo.test.ts
git commit -m "feat(server): household cascade/orphan delete + hasServerOwner"
```

---

### Task 3: userRepo.listOrphans()

**Files:** Modify `userRepo.ts`; Test `userRepo.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `userRepo.test.ts` (build a household so FK is satisfied for the assigned user):

```typescript
it('listOrphans returns only users with no household', () => {
  const households = createHouseholdRepo(db)
  const h = households.create('H', null).id
  const a = repo.create({ name: 'Assigned', householdId: h })
  const o1 = repo.create({ name: 'Orphan1' })   // no household
  const o2 = repo.create({ name: 'Orphan2' })
  const ids = repo.listOrphans().map(u => u.id).sort()
  expect(ids).toEqual([o1.id, o2.id].sort())
  expect(ids).not.toContain(a.id)
})
```

Add `import { createHouseholdRepo } from './householdRepo.ts'` to the test if absent.

- [ ] **Step 2: Run** `npx vitest run src/contexts/identity/infrastructure/persistence/userRepo.test.ts` → FAIL.

- [ ] **Step 3: Implement** — add to `UserRepo` interface `listOrphans(): User[]` and to the object:

```typescript
    listOrphans() {
      return (db.prepare('SELECT * FROM users WHERE household_id IS NULL ORDER BY created_at, rowid').all()).map(rowToUser)
    },
```

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/contexts/identity/infrastructure/persistence/userRepo.ts apps/server/src/contexts/identity/infrastructure/persistence/userRepo.test.ts
git commit -m "feat(server): userRepo.listOrphans()"
```

---

### Task 4: ensureHouseholds one-shot

**Files:** Modify `domain/household.ts`; Test `domain/household.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `household.test.ts`:

```typescript
it('is one-shot — a second run does not re-adopt a newly-orphaned user', () => {
  const users = createUserRepo(db)
  users.create({ name: 'Owner' })       // first user → owner
  ensureHouseholds(db)                   // backfills + sets the flag
  // Simulate an intentional orphan created AFTER the backfill.
  const households = createHouseholdRepo(db)
  const friendH = households.create('Friend', null).id
  const friend = users.create({ name: 'Friend', householdId: friendH })
  users.setHousehold(friend.id, friendH)
  // Orphan them (as delete-household orphan-mode would).
  db.prepare('UPDATE users SET household_id = NULL WHERE id = ?').run(friend.id)
  ensureHouseholds(db)                   // must be a NO-OP now
  expect(users.get(friend.id)?.householdId).toBeNull()
})
```

- [ ] **Step 2: Run** `npx vitest run src/contexts/identity/domain/household.test.ts` → FAIL (second run re-adopts the orphan).

- [ ] **Step 3: Implement** — guard with a `server_meta` flag. Replace the body of `ensureHouseholds`:

```typescript
const BACKFILL_FLAG = 'households_backfilled'

export function ensureHouseholds(db: DatabaseSync): void {
  // One-shot: after the first backfill, null-household users are INTENTIONAL
  // orphans (e.g. from delete-household orphan-mode) and must not be swept up.
  const done = db.prepare('SELECT value FROM server_meta WHERE key = ?').get(BACKFILL_FLAG)
  if (done) return

  const users = createUserRepo(db)
  const orphanIds = (db.prepare('SELECT id FROM users WHERE household_id IS NULL').all() as { id: string }[])
    .map(r => r.id)

  if (orphanIds.length > 0) {
    const households = createHouseholdRepo(db)
    const existing = db.prepare("SELECT id FROM households WHERE name = 'Home' LIMIT 1").get() as { id: string } | undefined
    const ownerRow = db.prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1").get() as { id: string } | undefined
    const ownerId = ownerRow?.id ?? orphanIds[0]
    const homeId = existing?.id ?? households.create('Home', ownerId).id
    for (const id of orphanIds) users.setHousehold(id, homeId)
  }

  // Mark done even when there were no orphans — a fresh install is already
  // "backfilled", so later intentional orphans are never swept.
  db.prepare('INSERT INTO server_meta (key, value) VALUES (?, ?)').run(BACKFILL_FLAG, '1')
}
```

Keep the existing imports + `export type { Household }`.

- [ ] **Step 4: Run** the file → PASS (and the existing ensureHouseholds tests still pass — they each use a fresh in-memory db, so the flag starts unset).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/contexts/identity/domain/household.ts apps/server/src/contexts/identity/domain/household.test.ts
git commit -m "feat(server): make ensureHouseholds one-shot so orphans persist"
```

---

# Phase 2 — Server routes

### Task 5: GET /households (list all)

**Files:** Modify `http/households.ts`; Test `http/households.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `households.test.ts` (mirror its app-builder; an admin/owner token + a second household):

```typescript
it('GET /households lists all households for an owner/admin', async () => {
  ctx.households.create('Friends', null)
  const res = await ctx.app.inject({ method: 'GET', url: '/households', headers: auth(ctx.token) })
  expect(res.statusCode).toBe(200)
  const names = (res.json() as { name: string }[]).map(h => h.name)
  expect(names).toContain('Friends')
})

it('GET /households is forbidden for a member', async () => {
  const memberId = ctx.users.create({ name: 'Mem', householdId: ctx.users.get(ctx.owner.id)!.householdId }).id
  const res = await ctx.app.inject({ method: 'GET', url: '/households', headers: auth(ctx.sessions.issue(memberId).token) })
  expect(res.statusCode).toBe(403)
})
```

> If the existing test file doesn't expose a `ctx` with `owner`/`token`/`households`/`users`/`sessions`, mirror the makeApp pattern from `invites.test.ts` and build one in this file (owner via `ensureHouseholds`, token via `sessions.issue(owner.id)`).

- [ ] **Step 2: Run** `npx vitest run src/contexts/identity/infrastructure/http/households.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `households.ts`, add inside `registerHouseholds` a helper + route:

```typescript
  function requireServerAdmin(req: FastifyRequest, reply: FastifyReply): { id: string; role: 'owner'|'admin'|'member' } | null {
    const caller = req.user
    if (!caller) { errorReply(reply, 401, ErrorCodes.UNAUTHORIZED, 'Authentication required'); return null }
    if (caller.role !== 'owner' && caller.role !== 'admin') {
      errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Server owner/admin only'); return null
    }
    return caller
  }

  app.get('/households', async (req, reply) => {
    if (!requireServerAdmin(req, reply)) return
    return households.list().map(h => ({
      id: h.id, name: h.name, ownerUserId: h.ownerUserId, members: users.listByHousehold(h.id),
    }))
  })
```

Add `import type { FastifyRequest, FastifyReply } from 'fastify'` if not present.

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/contexts/identity/infrastructure/http/households.ts apps/server/src/contexts/identity/infrastructure/http/households.test.ts
git commit -m "feat(server): GET /households (list all, admin)"
```

---

### Task 6: DELETE /households/:id (cascade / orphan + guard)

**Files:** Modify `http/households.ts`; Test `http/households.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('DELETE /households/:id deleteMembers=true removes household + members', async () => {
  const h = ctx.households.create('Doomed', null)
  const u = ctx.users.create({ name: 'Doom1', householdId: h.id })
  ctx.households.setOwner(h.id, u.id)
  const res = await ctx.app.inject({ method: 'DELETE', url: `/households/${h.id}`, headers: auth(ctx.token), payload: { deleteMembers: true } })
  expect(res.statusCode).toBe(204)
  expect(ctx.households.get(h.id)).toBeNull()
  expect(ctx.users.get(u.id)).toBeNull()
})

it('DELETE /households/:id deleteMembers=false orphans members', async () => {
  const h = ctx.households.create('Kept', null)
  const u = ctx.users.create({ name: 'Keep1', householdId: h.id })
  ctx.households.setOwner(h.id, u.id)
  const res = await ctx.app.inject({ method: 'DELETE', url: `/households/${h.id}`, headers: auth(ctx.token), payload: { deleteMembers: false } })
  expect(res.statusCode).toBe(204)
  expect(ctx.households.get(h.id)).toBeNull()
  expect(ctx.users.get(u.id)?.householdId).toBeNull()
})

it('refuses to delete the household containing the server owner (409)', async () => {
  const ownerHousehold = ctx.users.get(ctx.owner.id)!.householdId!
  const res = await ctx.app.inject({ method: 'DELETE', url: `/households/${ownerHousehold}`, headers: auth(ctx.token), payload: { deleteMembers: true } })
  expect(res.statusCode).toBe(409)
})

it('DELETE /households/:id is forbidden for a member (403)', async () => {
  const h = ctx.households.create('X', null)
  const memberId = ctx.users.create({ name: 'M2', householdId: ctx.users.get(ctx.owner.id)!.householdId }).id
  const res = await ctx.app.inject({ method: 'DELETE', url: `/households/${h.id}`, headers: auth(ctx.sessions.issue(memberId).token), payload: { deleteMembers: true } })
  expect(res.statusCode).toBe(403)
})
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — add the route + body schema:

```typescript
const DeleteBody = z.object({ deleteMembers: z.boolean() }).strict()

  app.delete('/households/:id', async (req, reply) => {
    if (!requireServerAdmin(req, reply)) return
    const id = (req.params as { id: string }).id
    const parse = DeleteBody.safeParse(req.body)
    if (!parse.success) return badRequest(reply, ErrorCodes.INVALID_INPUT, parse.error.message)
    if (!households.get(id)) return sendNotFound(reply, ErrorCodes.NOT_FOUND, 'Household not found')
    if (households.hasServerOwner(id)) {
      return errorReply(reply, 409, ErrorCodes.OWNER_PROTECTED, 'Cannot delete the server owner’s household')
    }
    if (parse.data.deleteMembers) households.deleteCascade(id)
    else households.deleteOrphaning(id)
    return reply.status(204).send()
  })
```

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/contexts/identity/infrastructure/http/households.ts apps/server/src/contexts/identity/infrastructure/http/households.test.ts
git commit -m "feat(server): DELETE /households/:id (cascade/orphan + owner guard)"
```

---

### Task 7: POST /households/:id/members (move a profile in)

**Files:** Modify `http/households.ts`; Test `http/households.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('POST /households/:id/members moves a profile (incl. an orphan) into the household', async () => {
  const h = ctx.households.create('Target', null)
  const orphan = ctx.users.create({ name: 'Lonely' })   // no household
  const res = await ctx.app.inject({ method: 'POST', url: `/households/${h.id}/members`, headers: auth(ctx.token), payload: { userId: orphan.id } })
  expect(res.statusCode).toBe(200)
  expect(ctx.users.get(orphan.id)?.householdId).toBe(h.id)
})

it('POST /households/:id/members 404s an unknown household', async () => {
  const orphan = ctx.users.create({ name: 'Lonely2' })
  const res = await ctx.app.inject({ method: 'POST', url: `/households/nope/members`, headers: auth(ctx.token), payload: { userId: orphan.id } })
  expect(res.statusCode).toBe(404)
})
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**:

```typescript
const AddMemberBody = z.object({ userId: z.string().min(1) }).strict()

  app.post('/households/:id/members', async (req, reply) => {
    if (!requireServerAdmin(req, reply)) return
    const id = (req.params as { id: string }).id
    const parse = AddMemberBody.safeParse(req.body)
    if (!parse.success) return badRequest(reply, ErrorCodes.INVALID_INPUT, parse.error.message)
    if (!households.get(id)) return sendNotFound(reply, ErrorCodes.NOT_FOUND, 'Household not found')
    if (!users.setHousehold(parse.data.userId, id)) return sendNotFound(reply, ErrorCodes.USER_NOT_FOUND, 'User not found')
    return { id, members: users.listByHousehold(id) }
  })
```

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/contexts/identity/infrastructure/http/households.ts apps/server/src/contexts/identity/infrastructure/http/households.test.ts
git commit -m "feat(server): POST /households/:id/members (move profile)"
```

---

### Task 8: GET /users/orphans

**Files:** Modify `http/users.ts`; Test `http/users.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('GET /users/orphans returns null-household users to an admin; 403 for a member', async () => {
  // owner + a fresh orphan (createUser via repo leaves no household when given none)
  const orphan = ctx.users.create({ name: 'NoHome' })
  const ok = await ctx.app.inject({ method: 'GET', url: '/users/orphans', headers: auth(ctx.ownerToken) })
  expect(ok.statusCode).toBe(200)
  expect((ok.json() as { id: string }[]).map(u => u.id)).toContain(orphan.id)

  const memberId = ctx.users.create({ name: 'Mm', householdId: ctx.users.get(ctx.owner.id)!.householdId }).id
  const forbidden = await ctx.app.inject({ method: 'GET', url: '/users/orphans', headers: auth(ctx.sessions.issue(memberId).token) })
  expect(forbidden.statusCode).toBe(403)
})
```

> Mirror the existing `users.test.ts` harness/`ctx`. **Register `/users/orphans` before the `/users/:id` route** so it isn't captured by the param route (Fastify matches static before param, but keep it ordered to be safe).

- [ ] **Step 2: Run** `npx vitest run src/contexts/identity/infrastructure/http/users.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `users.ts`, add before `app.get('/users/:id', …)`:

```typescript
  app.get('/users/orphans', async (req, reply) => {
    const caller = resolveCallerRole(req)
    if (!caller) return errorReply(reply, 401, ErrorCodes.UNAUTHORIZED, 'Authentication required')
    if (caller.role !== 'owner' && caller.role !== 'admin') {
      return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Server owner/admin only')
    }
    return users.listOrphans()
  })
```

(`resolveCallerRole`, `errorReply`, `ErrorCodes` are already imported in `users.ts`.)

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/contexts/identity/infrastructure/http/users.ts apps/server/src/contexts/identity/infrastructure/http/users.test.ts
git commit -m "feat(server): GET /users/orphans (admin)"
```

---

### Task 9: POST /invites — target household for join (admin)

**Files:** Modify `http/invites.ts`; Test `http/invites.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('owner can mint a join invite into ANOTHER household via householdId', async () => {
  const other = ctx.households.create('Other', null)
  const create = await ctx.app.inject({ method: 'POST', url: '/invites', headers: auth(ctx.ownerToken), payload: { kind: 'join', householdId: other.id } })
  expect(create.statusCode).toBe(200)
  // Redeeming joins the targeted household.
  const code = create.json().code as string
  const redeem = await ctx.app.inject({ method: 'POST', url: '/invites/redeem', payload: { code, name: 'Guest-X', password: 'longenough12' } })
  expect(redeem.statusCode).toBe(200)
  expect(ctx.users.get(redeem.json().user.id as string)?.householdId).toBe(other.id)
})

it('a member cannot target another household (403)', async () => {
  const other = ctx.households.create('Other2', null)
  const memberId = ctx.users.create({ name: 'Mem3', householdId: ctx.users.get(ctx.owner.id)!.householdId }).id
  const res = await ctx.app.inject({ method: 'POST', url: '/invites', headers: auth(ctx.sessions.issue(memberId).token), payload: { kind: 'join', householdId: other.id } })
  expect(res.statusCode).toBe(403)
})
```

- [ ] **Step 2: Run** `npx vitest run src/contexts/identity/infrastructure/http/invites.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `invites.ts`, extend the create body + target resolution. Change `CreateBody`:

```typescript
const CreateBody = z.object({ kind: z.enum(['join', 'new_household']), householdId: z.string().optional() }).strict()
```

In the `POST /invites` handler, after the existing kind-authorization checks, resolve the target household for `join`:

```typescript
    // join target: own household by default; owner/admin may target any household.
    let joinHouseholdId = callerUser.householdId
    if (kind === 'join' && parse.data.householdId && parse.data.householdId !== callerUser.householdId) {
      if (!isServerAdmin) return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Only server owner/admin can target another household')
      if (!households.get(parse.data.householdId)) return errorReply(reply, 404, ErrorCodes.NOT_FOUND, 'Household not found')
      joinHouseholdId = parse.data.householdId
    }
```

Then change the `invites.create({ … householdId: kind === 'join' ? callerUser.householdId : null … })` to use `kind === 'join' ? joinHouseholdId : null`.

- [ ] **Step 4: Run** → PASS (and existing invite tests stay green — default path unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/contexts/identity/infrastructure/http/invites.ts apps/server/src/contexts/identity/infrastructure/http/invites.test.ts
git commit -m "feat(server): admin can mint join invites into any household"
```

---

### Task 10: Full server suite + typecheck

- [ ] **Step 1:** `cd apps/server && npx tsc --noEmit` → clean.
- [ ] **Step 2:** `cd apps/server && npx vitest run` → all pass (new + existing, incl. the updated ensureHouseholds tests).
- [ ] **Step 3:** Commit only if a fix was needed; otherwise nothing to commit.

---

# Phase 3 — SDK & web

### Task 11: SDK methods

**Files:** Modify `libs/sdk/src/client/client.ts`; Test `libs/sdk/src/client/client.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('household admin', () => {
  it('all() GETs /api/households', async () => {
    const fn = spyFetch([])
    await new HorizonClient({ baseUrl: '' }).households.all()
    expect(fn.mock.calls[0][0]).toBe('/api/households')
  })
  it('remove() DELETEs with deleteMembers in the body', async () => {
    const fn = spyFetch({}, 204)
    await new HorizonClient({ baseUrl: '' }).households.remove('h1', true)
    const [url, init] = fn.mock.calls[0]
    expect(url).toBe('/api/households/h1'); expect(init.method).toBe('DELETE')
    expect(JSON.parse(init.body)).toEqual({ deleteMembers: true })
  })
  it('addMember() POSTs the userId', async () => {
    const fn = spyFetch({})
    await new HorizonClient({ baseUrl: '' }).households.addMember('h1', 'u9')
    expect(fn.mock.calls[0][0]).toBe('/api/households/h1/members')
    expect(JSON.parse(fn.mock.calls[0][1].body)).toEqual({ userId: 'u9' })
  })
  it('users.orphans() GETs /api/users/orphans', async () => {
    const fn = spyFetch([])
    await new HorizonClient({ baseUrl: '' }).users.orphans()
    expect(fn.mock.calls[0][0]).toBe('/api/users/orphans')
  })
  it('invites.create passes householdId when given', async () => {
    const fn = spyFetch({ code: 'A-1', expiresAt: 1 })
    await new HorizonClient({ baseUrl: '' }).invites.create({ kind: 'join', householdId: 'h2' })
    expect(JSON.parse(fn.mock.calls[0][1].body)).toEqual({ kind: 'join', householdId: 'h2' })
  })
})
```

- [ ] **Step 2: Run** `cd libs/sdk && npx vitest run src/client/client.test.ts -t "household admin"` → FAIL.

- [ ] **Step 3: Implement** — in `client.ts`:

Extend `households`:

```typescript
    all: () => this.fetch<HouseholdView[]>('/households'),
    remove: (id: string, deleteMembers: boolean) =>
      this.fetch<void>(`/households/${id}`, { method: 'DELETE', body: JSON.stringify({ deleteMembers }) }),
    addMember: (householdId: string, userId: string) =>
      this.fetch<HouseholdView>(`/households/${householdId}/members`, { method: 'POST', body: JSON.stringify({ userId }) }),
```

Add to `users`:

```typescript
    orphans: () => this.fetch<User[]>('/users/orphans'),
```

Change `invites.create` signature to accept `householdId`:

```typescript
    create: (body: { kind: InviteKind; householdId?: string }) =>
      this.fetch<InviteResult>('/invites', { method: 'POST', body: JSON.stringify(body) }),
```

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/sdk/src/client/client.ts libs/sdk/src/client/client.test.ts
git commit -m "feat(sdk): household admin methods (all/remove/addMember/orphans, invite householdId)"
```

---

### Task 12: AllHouseholdsPanel + Settings wiring

**Files:** Create `apps/web/src/features/settings/components/AllHouseholdsPanel.tsx` (+ `.css`, `.test.tsx`); Modify `Settings.tsx`

- [ ] **Step 1: Write the failing test**

`AllHouseholdsPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { horizon } from '../../../shared/horizon.ts'
import AllHouseholdsPanel from './AllHouseholdsPanel'

const HOUSEHOLDS = [
  { id: 'home', name: 'Home', ownerUserId: 'owner', members: [{ id: 'owner', name: 'Owner', role: 'owner' }] },
  { id: 'friend', name: 'Friend', ownerUserId: 'f1', members: [{ id: 'f1', name: 'Friend1', role: 'member' }] },
]

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(horizon.households, 'all').mockResolvedValue(HOUSEHOLDS as any)
  vi.spyOn(horizon.users, 'orphans').mockResolvedValue([{ id: 'orph', name: 'Lonely' }] as any)
})

describe('AllHouseholdsPanel', () => {
  it('lists all households + members and the orphans section', async () => {
    render(<AllHouseholdsPanel ownerUserId="owner" />)
    expect(await screen.findByText('Friend')).toBeInTheDocument()
    expect(screen.getByText('Home')).toBeInTheDocument()
    expect(screen.getByText('Lonely')).toBeInTheDocument()
  })

  it('deleting a household offers cascade vs orphan and calls remove with the flag', async () => {
    vi.spyOn(horizon.households, 'remove').mockResolvedValue(undefined as any)
    render(<AllHouseholdsPanel ownerUserId="owner" />)
    await screen.findByText('Friend')
    // open the delete dialog for the Friend household
    screen.getByRole('button', { name: /delete Friend/i }).click()
    screen.getByRole('button', { name: /delete household \+ members/i }).click()
    await waitFor(() => expect(horizon.households.remove).toHaveBeenCalledWith('friend', true))
  })

  it('does not offer delete for the server-owner household', async () => {
    render(<AllHouseholdsPanel ownerUserId="owner" />)
    await screen.findByText('Home')
    expect(screen.queryByRole('button', { name: /delete Home/i })).toBeNull()
  })
})
```

- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/features/settings/components/AllHouseholdsPanel.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

`AllHouseholdsPanel.tsx`:

```tsx
import { useEffect, useState, useCallback } from 'react'
import { horizon } from '../../../shared/horizon.ts'
import type { HouseholdView, User } from '@horizon/sdk'
import './AllHouseholdsPanel.css'

function inviteLink(code: string): string {
  return `${window.location.origin}/join?code=${code}`
}

export default function AllHouseholdsPanel({ ownerUserId }: { ownerUserId: string }) {
  const [households, setHouseholds] = useState<HouseholdView[]>([])
  const [orphans, setOrphans] = useState<User[]>([])
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<HouseholdView | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [hs, orph] = await Promise.all([horizon.households.all(), horizon.users.orphans()])
      setHouseholds(hs); setOrphans(orph)
    } catch { setError('Couldn’t load households.') }
  }, [])
  useEffect(() => { void load() }, [load])

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null)
    try { await fn(); await load() }
    catch { setError('Action failed.') }
    finally { setBusy(false) }
  }

  // True for the household that contains the server owner — never deletable.
  function isOwnerHousehold(h: HouseholdView): boolean {
    return h.members.some(m => m.id === ownerUserId)
  }

  return (
    <section className="settings__section">
      <p className="settings__section-title">All households</p>
      {error && <p className="settings__profile-error">{error}</p>}

      {households.map(h => (
        <div key={h.id} className="ahh__card">
          <div className="ahh__head">
            <span className="ahh__name">{h.name}</span>
            <button className="settings__token-replace" disabled={busy}
              onClick={() => run(async () => { const { code } = await horizon.invites.create({ kind: 'join', householdId: h.id }); setLink(inviteLink(code)) })}>
              Invite member
            </button>
            {!isOwnerHousehold(h) && (
              <button className="settings__token-cancel" aria-label={`Delete ${h.name}`} onClick={() => setConfirmDelete(h)}>Delete</button>
            )}
          </div>
          <ul className="ahh__members">
            {h.members.map(m => (
              <li key={m.id} className="ahh__member">
                <span>{m.name}</span>
                {m.id !== h.ownerUserId && (
                  <button className="settings__token-cancel" aria-label={`Remove ${m.name}`} disabled={busy}
                    onClick={() => run(() => horizon.users.delete(m.id))}>Remove</button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}

      {link && (
        <div className="ahh__link"><code>{link}</code>
          <button className="settings__token-replace" onClick={() => navigator.clipboard?.writeText(link)}>Copy</button>
        </div>
      )}

      <p className="settings__section-title">Unassigned profiles</p>
      {orphans.length === 0 && <p className="ahh__muted">None.</p>}
      <ul className="ahh__members">
        {orphans.map(o => (
          <li key={o.id} className="ahh__member">
            <span>{o.name}</span>
            <select className="settings__input" disabled={busy} defaultValue=""
              onChange={e => { const hid = e.target.value; if (hid) run(() => horizon.households.addMember(hid, o.id)) }}>
              <option value="" disabled>Move to…</option>
              {households.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
            <button className="settings__token-cancel" disabled={busy} onClick={() => run(() => horizon.users.delete(o.id))}>Delete</button>
          </li>
        ))}
      </ul>

      {confirmDelete && (
        <div className="ahh__dialog" role="dialog">
          <p>Delete “{confirmDelete.name}”? It has {confirmDelete.members.length} member(s).</p>
          <button className="settings__token-replace" disabled={busy}
            onClick={() => { const h = confirmDelete; setConfirmDelete(null); run(() => horizon.households.remove(h.id, true)) }}>
            Delete household + members
          </button>
          <button className="settings__token-replace" disabled={busy}
            onClick={() => { const h = confirmDelete; setConfirmDelete(null); run(() => horizon.households.remove(h.id, false)) }}>
            Keep members (unassign)
          </button>
          <button className="settings__token-cancel" onClick={() => setConfirmDelete(null)}>Cancel</button>
        </div>
      )}
    </section>
  )
}
```

`AllHouseholdsPanel.css`:

```css
.ahh__card { border: 1px solid var(--border, #333); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
.ahh__head { display: flex; align-items: center; gap: 8px; }
.ahh__name { font-weight: 600; flex: 1; }
.ahh__members { list-style: none; padding: 0; margin: 8px 0 0; }
.ahh__member { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.ahh__member span { flex: 1; }
.ahh__link { display: flex; gap: 8px; align-items: center; margin: 8px 0; flex-wrap: wrap; }
.ahh__muted { opacity: 0.6; font-size: 0.85em; }
.ahh__dialog { border: 1px solid var(--border, #333); border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
```

In `Settings.tsx`, render it under the **Server** tab (which is owner/admin-gated). Find the `{activeTab === 'Server' && (` block and add the panel inside it:

```tsx
import AllHouseholdsPanel from '../components/AllHouseholdsPanel'
// ... inside the Server tab fragment, after the existing panels:
            {user && <AllHouseholdsPanel ownerUserId={user.id} />}
```

> `user.id` is the server owner/admin viewing the Server tab; `isOwnerHousehold` hides delete for the household that contains them. (A server `admin` who isn't the `owner` could still see a delete button on the true owner's household, but the server guards it with 409 — surfaced as an inline error. Acceptable; the common case is the owner viewing.)

- [ ] **Step 4: Run** `cd apps/web && npx vitest run src/features/settings/components/AllHouseholdsPanel.test.tsx && npx tsc --noEmit` → PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/settings/components/AllHouseholdsPanel.tsx apps/web/src/features/settings/components/AllHouseholdsPanel.css apps/web/src/features/settings/components/AllHouseholdsPanel.test.tsx apps/web/src/features/settings/pages/Settings.tsx
git commit -m "feat(web): AllHouseholdsPanel — server-owner cross-household admin"
```

---

## Final verification

- [ ] `cd apps/server && npx tsc --noEmit && npx vitest run` → all pass.
- [ ] `cd libs/sdk && npx vitest run` → all pass.
- [ ] `cd apps/web && npx tsc --noEmit && npx vitest run` → all pass.
- [ ] `cd /Users/luuk/Projects/slimluccii/horizon && npx playwright test` → 26 pass (no regression).
- [ ] Manual smoke (optional): as owner, open Settings → Server → All households; a friend household appears; delete it with "keep members" → it's gone and the friend shows under Unassigned; move them into Home or delete.

## Notes for the implementer

- The `isOwnerHousehold` delete-hide is a client convenience; the server 409 guard (`hasServerOwner`) is authoritative.
- `ensureHouseholds` one-shot: existing tests each use a fresh in-memory DB (flag starts unset) so they keep passing; only the new one-shot test exercises the guard. If any existing test relied on a *second* `ensureHouseholds` call re-adopting, update it (none expected).
- Cascade deletes invites by `created_by` and `household_id` explicitly because those FKs lack `ON DELETE CASCADE` (sessions/progress/pairing do cascade).
