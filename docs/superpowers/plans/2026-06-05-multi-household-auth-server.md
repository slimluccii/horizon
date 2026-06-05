# Multi-Household Auth (Server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-side households, invites, and grant-based act-as so one paired device serves a group of profiles while isolating other households, and remove the legacy `X-Horizon-User` header in favor of session Bearer auth + `X-Horizon-Profile`.

**Architecture:** Households/invites/act-as are identity concerns, so they live in the **identity bounded context** (`apps/server/src/contexts/identity/`); cross-context access is via the context's `index.ts` barrel only. A request now has a **principal** (authenticated session user, for server-role checks) and an **active profile** (`X-Horizon-Profile`, validated against the session's grant, for per-user data). The media library stays server-wide.

**Tech Stack:** Fastify, better-sqlite3 (`DatabaseSync`), zod row schemas, vitest (co-located tests). Build/test from `apps/server`.

**Spec:** `docs/superpowers/specs/2026-06-05-multi-household-auth-server-design.md`

**Conventions to follow (verified in-repo):**
- DB migrations are pure DDL in `apps/server/src/platform/db/migrations.ts`; the runner bumps `PRAGMA user_version`. `server_meta` is **v2** (shipped with discovery) → household DDL is **v3**.
- Row→domain mapping uses zod schemas in `apps/server/src/platform/db/rowSchemas.ts`.
- Error codes are the single source of truth in `libs/sdk/src/shared/errors.ts` (`ErrorCodes`), imported server-side from `@horizon/sdk`.
- HTTP helpers: `errorReply`, `badRequest`, `sendNotFound` from `apps/server/src/platform/http/errors.ts`; `IpRateLimiter` from `apps/server/src/platform/http/rateLimit.ts`.
- Tests co-locate next to source (`*.test.ts`) and build a DB via `openDatabase(':memory:')` + `migrate(db)`.
- Commands: run from `apps/server`. Test a file: `npx vitest run <path>`. Full suite: `npx vitest run`. Typecheck: `npx tsc --noEmit`.

**Out of scope:** web UI, Android client (separate specs), PIN-per-profile, per-household library restrictions.

---

## File structure

**Identity context (`apps/server/src/contexts/identity/`)**
- `domain/household.ts` (new) — `ensureHouseholds(db)` idempotent backfill + `Household` type.
- `infrastructure/persistence/householdRepo.ts` (+ `.test.ts`) (new) — household CRUD + membership queries.
- `infrastructure/persistence/inviteRepo.ts` (+ `.test.ts`) (new) — invite create/get/consume.
- `infrastructure/persistence/userRepo.ts` — `householdId` on `User`, `create`, add `listByHousehold`, `setHousehold`.
- `infrastructure/persistence/sessionRepo.ts` — `grant` on `Session`; `issue(..., grant?)`; `granted_user_ids` on approve/poll.
- `infrastructure/authMiddleware.ts` — `resolveProfile` hook + `X-Horizon-Profile`; drop `X-Horizon-User`; allowlist `/invites/redeem`.
- `infrastructure/http/auth.ts` — grant on `pair/approve`; poll returns `profiles`; `GET /auth/grant`; login/poll stamp grant.
- `infrastructure/http/invites.ts` (+ `.test.ts`) (new) — `POST /invites`, `POST /invites/redeem`.
- `infrastructure/http/households.ts` (+ `.test.ts`) (new) — `GET /households/me`, `PATCH /households/:id`.
- `infrastructure/http/users.ts` — household-scoped `GET /users`.
- `index.ts` — barrel exports for the new repos/routes/`ensureHouseholds`.

**Platform**
- `platform/db/migrations.ts` — migration v3.
- `platform/db/rowSchemas.ts` — `household_id` on `UserRowSchema`; new `HouseholdRowSchema`, `InviteRowSchema`.
- `platform/http/server.ts` — register invites/households routes; install `resolveProfile` hook.
- `platform/composition/bootstrap.ts` — `ensureHouseholds(db)` after `migrate`.

**Shared**
- `libs/sdk/src/shared/errors.ts` — new `ErrorCodes`.

---

# Phase 1 — Schema & data model

### Task 1: Migration v3 (households, columns, invites)

**Files:**
- Modify: `apps/server/src/platform/db/migrations.ts`
- Test: `apps/server/src/platform/db/migrate.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/platform/db/migrate.test.ts`:

```typescript
it('migrates to v3 with households, invites, and act-as columns', () => {
  const db = openDatabase(':memory:')
  migrate(db)
  expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3)

  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .map(r => r.name)
  expect(tables).toContain('households')
  expect(tables).toContain('invites')

  const userCols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map(c => c.name)
  expect(userCols).toContain('household_id')
  const sessCols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(c => c.name)
  expect(sessCols).toContain('grant_user_ids')
  const pairCols = (db.prepare('PRAGMA table_info(pairing_codes)').all() as { name: string }[]).map(c => c.name)
  expect(pairCols).toContain('granted_user_ids')
})
```

Also update the existing idempotency assertion (search for `toEqual([1, 2]`) to `toEqual([1, 2, 3])`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/platform/db/migrate.test.ts`
Expected: FAIL — user_version is 2; no `households`.

- [ ] **Step 3: Implement migration v3**

In `apps/server/src/platform/db/migrations.ts`, after the `V2_SQL` constant add:

```typescript
const V3_SQL = `
CREATE TABLE households (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  owner_user_id TEXT REFERENCES users(id),
  created_at    INTEGER NOT NULL
);

ALTER TABLE users         ADD COLUMN household_id TEXT REFERENCES households(id);
ALTER TABLE sessions      ADD COLUMN grant_user_ids TEXT;     -- JSON array; null = [user_id]
ALTER TABLE pairing_codes ADD COLUMN granted_user_ids TEXT;   -- JSON array

CREATE TABLE invites (
  code         TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK(kind IN ('join','new_household')),
  household_id TEXT REFERENCES households(id),
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER
);
`
```

Extend the `MIGRATIONS` array:

```typescript
const MIGRATIONS: Migration[] = [
  { version: 1, sql: V1_SQL },
  { version: 2, sql: V2_SQL },
  { version: 3, sql: V3_SQL },
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run src/platform/db/migrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/platform/db/migrations.ts apps/server/src/platform/db/migrate.test.ts
git commit -m "feat(server): migration v3 — households, invites, act-as columns"
```

---

### Task 2: Row schemas for households + invites + user.household_id

**Files:**
- Modify: `apps/server/src/platform/db/rowSchemas.ts`

- [ ] **Step 1: Implement (schemas are consumed by repos in later tasks; no standalone test — exercised by Task 3/5 repo tests)**

In `apps/server/src/platform/db/rowSchemas.ts`, add `household_id` to the user schema. Find `export const UserRowSchema = z.object({` and add this field inside it (nullable — backfilled at boot):

```typescript
  household_id: z.string().nullable(),
```

Then append two new schemas at the end of the file:

```typescript
export const HouseholdRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner_user_id: z.string().nullable(),
  created_at: z.number(),
})
export type HouseholdRow = z.infer<typeof HouseholdRowSchema>

export const InviteRowSchema = z.object({
  code: z.string(),
  kind: z.enum(['join', 'new_household']),
  household_id: z.string().nullable(),
  created_by: z.string(),
  created_at: z.number(),
  expires_at: z.number(),
  consumed_at: z.number().nullable(),
})
export type InviteRow = z.infer<typeof InviteRowSchema>
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/server && npx tsc --noEmit`
Expected: PASS (the new `household_id` field is nullable, so existing `rowToUser` keeps compiling; it will be consumed in Task 4).

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/platform/db/rowSchemas.ts
git commit -m "feat(server): row schemas for households, invites, user.household_id"
```

---

# Phase 2 — Repos & domain

### Task 3: Household repo

**Files:**
- Create: `apps/server/src/contexts/identity/infrastructure/persistence/householdRepo.ts`
- Test: `apps/server/src/contexts/identity/infrastructure/persistence/householdRepo.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/server/src/contexts/identity/infrastructure/persistence/householdRepo.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../../../platform/db/connection.ts'
import { migrate } from '../../../../platform/db/migrations.ts'
import { createHouseholdRepo, type HouseholdRepo } from './householdRepo.ts'

function fresh(): { db: DatabaseSync; repo: HouseholdRepo } {
  const db = openDatabase(':memory:')
  migrate(db)
  return { db, repo: createHouseholdRepo(db) }
}

describe('householdRepo', () => {
  let db: DatabaseSync
  let repo: HouseholdRepo
  beforeEach(() => { ({ db, repo } = fresh()) })

  it('creates a household with a generated id', () => {
    const h = repo.create('Home', null)
    expect(h.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(h.name).toBe('Home')
    expect(repo.get(h.id)).toEqual(h)
  })

  it('rename updates the name', () => {
    const h = repo.create('Home', null)
    repo.rename(h.id, 'Living Room')
    expect(repo.get(h.id)?.name).toBe('Living Room')
  })

  it('setOwner records the owner', () => {
    const h = repo.create('Home', null)
    repo.setOwner(h.id, 'user-1')
    expect(repo.get(h.id)?.ownerUserId).toBe('user-1')
  })

  it('get returns null for an unknown id', () => {
    expect(repo.get('nope')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/contexts/identity/infrastructure/persistence/householdRepo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/server/src/contexts/identity/infrastructure/persistence/householdRepo.ts`:

```typescript
import crypto from 'node:crypto'
import type { DatabaseSync } from '../../../../platform/db/connection.ts'
import { HouseholdRowSchema } from '../../../../platform/db/rowSchemas.ts'

export interface Household {
  id: string
  name: string
  ownerUserId: string | null
  createdAt: number
}

export interface HouseholdRepo {
  create(name: string, ownerUserId: string | null): Household
  get(id: string): Household | null
  rename(id: string, name: string): boolean
  setOwner(id: string, ownerUserId: string): boolean
}

function rowToHousehold(raw: unknown): Household {
  const row = HouseholdRowSchema.parse(raw)
  return { id: row.id, name: row.name, ownerUserId: row.owner_user_id, createdAt: row.created_at }
}

export function createHouseholdRepo(db: DatabaseSync): HouseholdRepo {
  return {
    create(name, ownerUserId) {
      const id = crypto.randomUUID()
      const now = Date.now()
      db.prepare('INSERT INTO households (id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
        .run(id, name, ownerUserId, now)
      return { id, name, ownerUserId, createdAt: now }
    },
    get(id) {
      const row = db.prepare('SELECT * FROM households WHERE id = ?').get(id)
      return row ? rowToHousehold(row) : null
    },
    rename(id, name) {
      return db.prepare('UPDATE households SET name = ? WHERE id = ?').run(name, id).changes > 0
    },
    setOwner(id, ownerUserId) {
      return db.prepare('UPDATE households SET owner_user_id = ? WHERE id = ?').run(ownerUserId, id).changes > 0
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run src/contexts/identity/infrastructure/persistence/householdRepo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/contexts/identity/infrastructure/persistence/householdRepo.ts apps/server/src/contexts/identity/infrastructure/persistence/householdRepo.test.ts
git commit -m "feat(server): household repo"
```

---

### Task 4: User repo — household_id + scoping helpers

**Files:**
- Modify: `apps/server/src/contexts/identity/infrastructure/persistence/userRepo.ts`
- Test: `apps/server/src/contexts/identity/infrastructure/persistence/userRepo.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `userRepo.test.ts`:

```typescript
it('assigns and reads household_id; lists by household', () => {
  const a = repo.create({ name: 'A', householdId: 'h1' })
  const b = repo.create({ name: 'B', householdId: 'h1' })
  repo.create({ name: 'C', householdId: 'h2' })
  expect(a.householdId).toBe('h1')
  expect(repo.listByHousehold('h1').map(u => u.name).sort()).toEqual(['A', 'B'])
  repo.setHousehold(b.id, 'h2')
  expect(repo.get(b.id)?.householdId).toBe('h2')
  expect(repo.listByHousehold('h1').map(u => u.name)).toEqual(['A'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/contexts/identity/infrastructure/persistence/userRepo.test.ts`
Expected: FAIL — `householdId` not on `User`/`UserInsert`; `listByHousehold`/`setHousehold` missing.

- [ ] **Step 3: Implement**

In `userRepo.ts`:

Add `householdId` to the `User` interface (after `passwordSetAt`):

```typescript
  householdId: string | null
```

Add to `UserInsert`:

```typescript
  householdId?: string | null
```

Add to the `UserRepo` interface:

```typescript
  /** Users in a household, in insertion order. */
  listByHousehold(householdId: string): User[]
  /** Move a user into a household. Returns false if no such user. */
  setHousehold(id: string, householdId: string): boolean
```

In `rowToUser`, add to the returned object:

```typescript
    householdId: row.household_id,
```

Find the `create` implementation's `INSERT INTO users (...)` and add the `household_id` column + value. The current insert lists explicit columns; add `household_id` to the column list and `input.householdId ?? null` to the values (in the matching position).

Add the two new methods to the returned repo object (place near `list`):

```typescript
    listByHousehold(householdId) {
      const rows = db.prepare('SELECT * FROM users WHERE household_id = ? ORDER BY created_at, rowid').all(householdId)
      return rows.map(rowToUser)
    },
    setHousehold(id, householdId) {
      return db.prepare('UPDATE users SET household_id = ?, updated_at = ? WHERE id = ?')
        .run(householdId, Date.now(), id).changes > 0
    },
```

> If `list()` already orders by `created_at, rowid`, mirror that exact ORDER BY in `listByHousehold` for consistency.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run src/contexts/identity/infrastructure/persistence/userRepo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/contexts/identity/infrastructure/persistence/userRepo.ts apps/server/src/contexts/identity/infrastructure/persistence/userRepo.test.ts
git commit -m "feat(server): user household_id + household-scoped queries"
```

---

### Task 5: `ensureHouseholds` boot backfill

**Files:**
- Create: `apps/server/src/contexts/identity/domain/household.ts`
- Test: `apps/server/src/contexts/identity/domain/household.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/server/src/contexts/identity/domain/household.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../../platform/db/connection.ts'
import { migrate } from '../../../platform/db/migrations.ts'
import { createUserRepo } from '../infrastructure/persistence/userRepo.ts'
import { createHouseholdRepo } from '../infrastructure/persistence/householdRepo.ts'
import { ensureHouseholds } from './household.ts'

function fresh(): DatabaseSync {
  const db = openDatabase(':memory:')
  migrate(db)
  return db
}

describe('ensureHouseholds', () => {
  let db: DatabaseSync
  beforeEach(() => { db = fresh() })

  it('assigns household-less users to a single Home household owned by the owner', () => {
    const users = createUserRepo(db)
    const owner = users.create({ name: 'Owner' })           // create() auto-elects first user owner
    users.create({ name: 'Member' })
    ensureHouseholds(db)
    const refreshedOwner = users.get(owner.id)!
    expect(refreshedOwner.householdId).not.toBeNull()
    const households = createHouseholdRepo(db)
    const home = households.get(refreshedOwner.householdId!)!
    expect(home.name).toBe('Home')
    expect(home.ownerUserId).toBe(owner.id)
    // every user landed in the same household
    expect(new Set(users.list().map(u => u.householdId)).size).toBe(1)
  })

  it('is idempotent — a second run creates no new household', () => {
    const users = createUserRepo(db)
    users.create({ name: 'Owner' })
    ensureHouseholds(db)
    ensureHouseholds(db)
    const count = (db.prepare('SELECT COUNT(*) c FROM households').get() as { c: number }).c
    expect(count).toBe(1)
  })

  it('no-op on an empty user table', () => {
    ensureHouseholds(db)
    expect((db.prepare('SELECT COUNT(*) c FROM households').get() as { c: number }).c).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/contexts/identity/domain/household.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/server/src/contexts/identity/domain/household.ts`:

```typescript
import type { DatabaseSync } from '../../../platform/db/connection.ts'
import { createUserRepo } from '../infrastructure/persistence/userRepo.ts'
import { createHouseholdRepo } from '../infrastructure/persistence/householdRepo.ts'

export type { Household } from '../infrastructure/persistence/householdRepo.ts'

/**
 * Idempotent boot backfill: ensure every user belongs to a household. On a DB
 * predating households (or a fresh dev DB), create a single "Home" household
 * owned by the server `owner` and move all household-less users into it. No-op
 * once everyone is assigned. Mirrors the loadIdentity / bootstrapFromEnv pattern
 * — dynamic data setup stays out of pure-DDL migrations.
 */
export function ensureHouseholds(db: DatabaseSync): void {
  const users = createUserRepo(db)
  const orphanIds = (db.prepare('SELECT id FROM users WHERE household_id IS NULL').all() as { id: string }[])
    .map(r => r.id)
  if (orphanIds.length === 0) return

  const households = createHouseholdRepo(db)
  // Reuse an existing Home (e.g. partial prior run) before making a new one.
  const existing = db.prepare("SELECT id FROM households WHERE name = 'Home' LIMIT 1").get() as
    | { id: string }
    | undefined
  const ownerRow = db.prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1").get() as
    | { id: string }
    | undefined
  const homeId = existing?.id ?? households.create('Home', ownerRow?.id ?? null).id
  if (!existing && !ownerRow) {
    // Defensive: households exist only to hold users; an owner is expected.
  }
  for (const id of orphanIds) users.setHousehold(id, homeId)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run src/contexts/identity/domain/household.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/contexts/identity/domain/household.ts apps/server/src/contexts/identity/domain/household.test.ts
git commit -m "feat(server): ensureHouseholds boot backfill"
```

---

### Task 6: Session grant (issue/resolve + pairing grant)

**Files:**
- Modify: `apps/server/src/contexts/identity/infrastructure/persistence/sessionRepo.ts`
- Test: `apps/server/src/contexts/identity/infrastructure/persistence/sessionRepo.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `sessionRepo.test.ts` (mirror the file's existing `freshRepo`/db setup):

```typescript
it('issue stores a grant and resolve returns it', () => {
  const { token } = repo.issue('u1', null, ['u1', 'u2'])
  expect(repo.resolve(token)?.grant).toEqual(['u1', 'u2'])
})

it('issue without a grant defaults grant to [userId]', () => {
  const { token } = repo.issue('u1', null)
  expect(repo.resolve(token)?.grant).toEqual(['u1'])
})

it('pairing approve records granted user ids; getPairingCode returns them', () => {
  const now = Date.now()
  repo.createPairingCode('AB-12', now, now + 60_000)
  repo.approvePairingCode('AB-12', 'approver', ['approver', 'partner'])
  const pc = repo.getPairingCode('AB-12')
  expect(pc?.approvedUserId).toBe('approver')
  expect(pc?.grantedUserIds).toEqual(['approver', 'partner'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/contexts/identity/infrastructure/persistence/sessionRepo.test.ts`
Expected: FAIL — `issue` takes 2 args; `Session.grant`/`PairingCode.grantedUserIds` absent.

- [ ] **Step 3: Implement**

In `sessionRepo.ts`:

Add `grant` to the `Session` interface:

```typescript
  /** User ids this session may act as (X-Horizon-Profile). Defaults to [userId]. */
  grant: string[]
```

Add `grantedUserIds` to the `PairingCode` interface:

```typescript
  grantedUserIds: string[] | null
```

Change the `SessionRepo.issue` signature:

```typescript
  issue(userId: string, userAgent?: string | null, grant?: string[]): { token: string; session: Session }
```

Change `approvePairingCode`:

```typescript
  approvePairingCode(code: string, userId: string, grantedUserIds: string[]): void
```

In `rowToSession`, parse the grant column (default to `[user_id]` when null):

```typescript
function rowToSession(row: {
  id: string; user_id: string; created_at: number; expires_at: number
  last_seen_at: number; user_agent: string | null; grant_user_ids: string | null
}): Session {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    userAgent: row.user_agent,
    grant: row.grant_user_ids ? (JSON.parse(row.grant_user_ids) as string[]) : [row.user_id],
  }
}
```

In `issue`, persist the grant and include it in the returned session:

```typescript
    issue(userId, userAgent, grant) {
      const now = Date.now()
      const id = crypto.randomUUID()
      const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url')
      const tokenHash = hashToken(token)
      const expiresAt = now + SESSION_TTL_MS
      const grantJson = grant ? JSON.stringify(grant) : null
      db.prepare(
        `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, grant_user_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, tokenHash, userId, now, expiresAt, now, userAgent ?? null, grantJson)
      return {
        token,
        session: {
          id, userId, createdAt: now, expiresAt, lastSeenAt: now,
          userAgent: userAgent ?? null, grant: grant ?? [userId],
        },
      }
    },
```

In `resolve`, the `SELECT *` already returns `grant_user_ids`; ensure the row object passed to `rowToSession` includes it (with `SELECT *` it does). If `resolve` constructs the row object field-by-field, add `grant_user_ids: row.grant_user_ids`.

In `approvePairingCode`, persist grant:

```typescript
    approvePairingCode(code, userId, grantedUserIds) {
      db.prepare('UPDATE pairing_codes SET approved_user_id = ?, granted_user_ids = ? WHERE code = ?')
        .run(userId, JSON.stringify(grantedUserIds), code)
    },
```

In `getPairingCode`, map the new column:

```typescript
      grantedUserIds: row.granted_user_ids ? (JSON.parse(row.granted_user_ids) as string[]) : null,
```

(The `getPairingCode` `SELECT *` already returns `granted_user_ids`; add it to the row type annotation.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run src/contexts/identity/infrastructure/persistence/sessionRepo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/contexts/identity/infrastructure/persistence/sessionRepo.ts apps/server/src/contexts/identity/infrastructure/persistence/sessionRepo.test.ts
git commit -m "feat(server): session grant + pairing granted_user_ids"
```

---

### Task 7: Invite repo

**Files:**
- Create: `apps/server/src/contexts/identity/infrastructure/persistence/inviteRepo.ts`
- Test: `apps/server/src/contexts/identity/infrastructure/persistence/inviteRepo.test.ts`

- [ ] **Step 1: Write the failing test**

`inviteRepo.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../../../platform/db/connection.ts'
import { migrate } from '../../../../platform/db/migrations.ts'
import { createInviteRepo, type InviteRepo } from './inviteRepo.ts'

function fresh(): InviteRepo {
  const db: DatabaseSync = openDatabase(':memory:')
  migrate(db)
  return createInviteRepo(db)
}

describe('inviteRepo', () => {
  let repo: InviteRepo
  beforeEach(() => { repo = fresh() })

  it('creates and reads a join invite', () => {
    const now = Date.now()
    repo.create({ code: 'JOIN-1', kind: 'join', householdId: 'h1', createdBy: 'u1', createdAt: now, expiresAt: now + 1000 })
    const inv = repo.get('JOIN-1')!
    expect(inv.kind).toBe('join')
    expect(inv.householdId).toBe('h1')
    expect(inv.consumedAt).toBeNull()
  })

  it('consume stamps consumed_at; double-consume returns false', () => {
    const now = Date.now()
    repo.create({ code: 'NH-1', kind: 'new_household', householdId: null, createdBy: 'u1', createdAt: now, expiresAt: now + 1000 })
    expect(repo.consume('NH-1', now)).toBe(true)
    expect(repo.get('NH-1')?.consumedAt).toBe(now)
    expect(repo.consume('NH-1', now)).toBe(false)
  })

  it('get returns null for unknown code', () => {
    expect(repo.get('nope')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/contexts/identity/infrastructure/persistence/inviteRepo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`inviteRepo.ts`:

```typescript
import type { DatabaseSync } from '../../../../platform/db/connection.ts'
import { InviteRowSchema } from '../../../../platform/db/rowSchemas.ts'

export type InviteKind = 'join' | 'new_household'

export interface Invite {
  code: string
  kind: InviteKind
  householdId: string | null
  createdBy: string
  createdAt: number
  expiresAt: number
  consumedAt: number | null
}

export interface InviteInsert {
  code: string
  kind: InviteKind
  householdId: string | null
  createdBy: string
  createdAt: number
  expiresAt: number
}

export interface InviteRepo {
  /** Insert a fresh invite. Throws on a primary-key collision (caller retries). */
  create(input: InviteInsert): void
  get(code: string): Invite | null
  /** Mark an invite consumed at [now]. Returns false if already consumed/unknown. */
  consume(code: string, now: number): boolean
}

function rowToInvite(raw: unknown): Invite {
  const row = InviteRowSchema.parse(raw)
  return {
    code: row.code,
    kind: row.kind,
    householdId: row.household_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  }
}

export function createInviteRepo(db: DatabaseSync): InviteRepo {
  return {
    create(input) {
      db.prepare(
        `INSERT INTO invites (code, kind, household_id, created_by, created_at, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      ).run(input.code, input.kind, input.householdId, input.createdBy, input.createdAt, input.expiresAt)
    },
    get(code) {
      const row = db.prepare('SELECT * FROM invites WHERE code = ?').get(code)
      return row ? rowToInvite(row) : null
    },
    consume(code, now) {
      return db.prepare('UPDATE invites SET consumed_at = ? WHERE code = ? AND consumed_at IS NULL')
        .run(now, code).changes > 0
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run src/contexts/identity/infrastructure/persistence/inviteRepo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/contexts/identity/infrastructure/persistence/inviteRepo.ts apps/server/src/contexts/identity/infrastructure/persistence/inviteRepo.test.ts
git commit -m "feat(server): invite repo"
```

---

# Phase 3 — Auth middleware, error codes, barrel

### Task 8: New error codes

**Files:**
- Modify: `libs/sdk/src/shared/errors.ts`

- [ ] **Step 1: Implement (consumed by route tasks; covered by their tests)**

In `libs/sdk/src/shared/errors.ts`, add these entries to the `ErrorCodes` object (keep the alphabetical-ish grouping):

```typescript
  GRANT_FORBIDDEN: 'grant-forbidden',
  INVITE_EXPIRED: 'invite-expired',
  INVITE_NOT_FOUND: 'invite-not-found',
  PROFILE_NOT_GRANTED: 'profile-not-granted',
```

- [ ] **Step 2: Typecheck both packages**

Run: `cd apps/server && npx tsc --noEmit` and `cd ../../libs/sdk && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add libs/sdk/src/shared/errors.ts
git commit -m "feat(sdk): error codes for grant + invite flows"
```

---

### Task 9: `resolveProfile` hook + drop X-Horizon-User + allowlist redeem

**Files:**
- Modify: `apps/server/src/contexts/identity/infrastructure/authMiddleware.ts`
- Test: `apps/server/src/contexts/identity/infrastructure/authMiddleware.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `authMiddleware.test.ts` (reuse its existing fake req/reply helpers; if it builds requests inline, mirror that). The hook factory `makeResolveProfile(sessionRepo, userRepo)` returns a Fastify `preHandler` that reads `req.user` (set by `requireAuth`), reads the session grant, validates `X-Horizon-Profile`, and sets `req.profileUserId`.

```typescript
import { makeResolveProfile } from './authMiddleware.ts'

describe('resolveProfile', () => {
  // Minimal fakes — resolveProfile only needs req.user, the profile header, and
  // a way to fetch the session grant for the principal's current token.
  function reqWith(profileHeader: string | undefined, grant: string[]) {
    return {
      user: { id: 'principal', role: 'member' as const },
      headers: profileHeader ? { 'x-horizon-profile': profileHeader, authorization: 'Bearer t' } : { authorization: 'Bearer t' },
      // resolveProfile resolves the session by token to read its grant:
      __grant: grant,
    } as any
  }
  const sessionRepo = { resolve: (_t: string) => ({ userId: 'principal', grant: ['principal', 'partner'] }) } as any
  const userRepo = { get: (id: string) => ({ id, role: 'member' }) } as any
  const hook = makeResolveProfile(sessionRepo, userRepo)

  it('defaults profileUserId to the principal when no header', async () => {
    const req = reqWith(undefined, ['principal'])
    const reply = { code: () => reply, send: () => reply } as any
    await hook(req, reply)
    expect(req.profileUserId).toBe('principal')
  })

  it('accepts a profile in the grant', async () => {
    const req = reqWith('partner', ['principal', 'partner'])
    const reply = { code: () => reply, send: () => reply } as any
    await hook(req, reply)
    expect(req.profileUserId).toBe('partner')
  })

  it('rejects a profile not in the grant with 403 profile-not-granted', async () => {
    const req = reqWith('stranger', ['principal', 'partner'])
    let status = 0; let body: any
    const reply = { status: (c: number) => { status = c; return reply }, send: (b: any) => { body = b; return reply } } as any
    await hook(req, reply)
    expect(status).toBe(403)
    expect(body.code).toBe('profile-not-granted')
    expect(req.profileUserId).toBeUndefined()
  })
})
```

> Adapt the fake shapes to whatever `requireAuth`'s existing tests use in this file; the contract under test is: header validated against `session.grant`, set `req.profileUserId`, else 403.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/contexts/identity/infrastructure/authMiddleware.test.ts`
Expected: FAIL — `makeResolveProfile` undefined.

- [ ] **Step 3: Implement**

In `authMiddleware.ts`:

Add the active-profile field to the Fastify request augmentation (next to the existing `user?` declaration):

```typescript
declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthedUser
    /** Active profile (X-Horizon-Profile), validated against the session grant. */
    profileUserId?: string
  }
}
```

Add `/invites/redeem` to `AUTH_ALLOWLIST`:

```typescript
export const AUTH_ALLOWLIST: ReadonlyArray<string> = [
  '/health',
  '/auth/login',
  '/auth/pair/start',
  '/auth/pair/poll',
  '/invites/redeem',
]
```

Add the header constant + hook factory:

```typescript
export const PROFILE_HEADER = 'x-horizon-profile'

/**
 * Build a preHandler (runs after requireAuth) that resolves the ACTIVE PROFILE.
 * Reads X-Horizon-Profile; with no header the active profile is the principal.
 * Otherwise the target must be in the session's grant, else 403. The session is
 * re-resolved by token to read its grant (the principal is already known from
 * requireAuth, but the grant lives on the session).
 */
export function makeResolveProfile(sessionRepo: SessionRepo, userRepo: UserRepo) {
  return async function resolveProfile(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!req.user) return // allowlisted routes never set req.user; nothing to resolve
    const raw = req.headers[PROFILE_HEADER]
    const target = Array.isArray(raw) ? raw[0] : raw
    if (!target) { req.profileUserId = req.user.id; return }

    const token = tokenFromRequest(req)
    const session = token ? sessionRepo.resolve(token) : null
    const grant = session?.grant ?? [req.user.id]
    if (!grant.includes(target)) {
      await reply.status(403).send({ error: 'Profile not granted', code: ErrorCodes.PROFILE_NOT_GRANTED })
      return
    }
    req.profileUserId = target
  }
}
```

Ensure `ErrorCodes`, `SessionRepo`, `UserRepo`, `tokenFromRequest`, `FastifyRequest`, `FastifyReply` are imported in this file (most already are; add `ErrorCodes` from `@horizon/sdk` and the repo types if missing).

**Remove `X-Horizon-User`:** grep the identity context for `X-Horizon-User` / `x-horizon-user` and delete any remaining read of it (the auth cutover already replaced most; this confirms none remain).

```bash
grep -rn "[Xx]-[Hh]orizon-[Uu]ser" apps/server/src && echo "FOUND — remove" || echo "clean"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run src/contexts/identity/infrastructure/authMiddleware.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/contexts/identity/infrastructure/authMiddleware.ts apps/server/src/contexts/identity/infrastructure/authMiddleware.test.ts
git commit -m "feat(server): resolveProfile act-as hook; allowlist /invites/redeem"
```

---

# Phase 4 — HTTP routes

### Task 10: Invite routes (create + redeem)

**Files:**
- Create: `apps/server/src/contexts/identity/infrastructure/http/invites.ts`
- Test: `apps/server/src/contexts/identity/infrastructure/http/invites.test.ts`

**Context:** Follow the registration + test pattern of `infrastructure/http/auth.ts` and its test (`auth.test.ts`) — a `register…(app, repos…)` function, a short pairing-code-style code generator (reuse the `PAIR_ALPHABET` approach from `auth.ts`), and an `IpRateLimiter`. Routes: `POST /invites` (auth; kind-split authorization) and `POST /invites/redeem` (unauthenticated; rate-limited; creates user/household + issues a session).

- [ ] **Step 1: Write the failing test**

`invites.test.ts` — build a real Fastify app with the identity repos over an in-memory DB, register `requireAuth` + `registerInvites`, authenticate with `asUser(token)` from the identity test helper. Cover: owner creates `new_household`; member forbidden to create `new_household` (403); household owner creates `join`; redeem `join` adds the user to the household; redeem `new_household` creates a household whose owner is the redeemer; expired/consumed/unknown rejected; redeem over the rate limit → 429.

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { openDatabase, type DatabaseSync } from '../../../../platform/db/connection.ts'
import { migrate } from '../../../../platform/db/migrations.ts'
import { createUserRepo } from '../persistence/userRepo.ts'
import { createSessionRepo } from '../persistence/sessionRepo.ts'
import { createHouseholdRepo } from '../persistence/householdRepo.ts'
import { createInviteRepo } from '../persistence/inviteRepo.ts'
import { ensureHouseholds } from '../../domain/household.ts'
import { makeRequireAuth } from '../authMiddleware.ts'
import { registerInvites } from './invites.ts'

async function makeApp() {
  const db: DatabaseSync = openDatabase(':memory:')
  migrate(db)
  const users = createUserRepo(db)
  const sessions = createSessionRepo(db)
  const households = createHouseholdRepo(db)
  const invites = createInviteRepo(db)
  const owner = users.create({ name: 'Owner' })   // auto owner
  ensureHouseholds(db)
  const ownerToken = sessions.issue(owner.id).token

  const app = Fastify()
  app.addHook('onRequest', makeRequireAuth(sessions, users))
  registerInvites(app, { users, sessions, households, invites })
  await app.ready()
  return { app, db, users, sessions, households, invites, owner, ownerToken }
}

function auth(token: string) { return { authorization: `Bearer ${token}` } }

describe('invites', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>
  beforeEach(async () => { ctx = await makeApp() })

  it('owner creates a new_household invite, friend redeems → own household + ownership', async () => {
    const create = await ctx.app.inject({ method: 'POST', url: '/invites', headers: auth(ctx.ownerToken), payload: { kind: 'new_household' } })
    expect(create.statusCode).toBe(200)
    const code = create.json().code as string

    const redeem = await ctx.app.inject({ method: 'POST', url: '/invites/redeem', payload: { code, name: 'Friend', password: 'hunter2hunter' } })
    expect(redeem.statusCode).toBe(200)
    const friendId = redeem.json().user.id as string
    const friend = ctx.users.get(friendId)!
    const ownerHousehold = ctx.users.get(ctx.owner.id)!.householdId
    expect(friend.householdId).not.toBe(ownerHousehold)            // isolated household
    expect(ctx.households.get(friend.householdId!)!.ownerUserId).toBe(friendId)  // redeemer owns it
  })

  it('a member cannot create a new_household invite (403)', async () => {
    const memberId = ctx.users.create({ name: 'Member', householdId: ctx.users.get(ctx.owner.id)!.householdId }).id
    const memberToken = ctx.sessions.issue(memberId).token
    const res = await ctx.app.inject({ method: 'POST', url: '/invites', headers: auth(memberToken), payload: { kind: 'new_household' } })
    expect(res.statusCode).toBe(403)
  })

  it('redeem of an unknown code → 404 invite-not-found', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/invites/redeem', payload: { code: 'NOPE-0000', name: 'X', password: 'longenough12' } })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('invite-not-found')
  })
})
```

> The join-invite + expired/consumed + rate-limit cases follow the same shape; add them with `repo.consume`/manual `expires_at` manipulation and a loop exceeding the redeem limit.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/contexts/identity/infrastructure/http/invites.test.ts`
Expected: FAIL — `registerInvites` undefined.

- [ ] **Step 3: Implement**

`invites.ts`:

```typescript
import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ErrorCodes } from '@horizon/sdk'
import { errorReply, badRequest } from '../../../../platform/http/errors.ts'
import { IpRateLimiter } from '../../../../platform/http/rateLimit.ts'
import { hash as hashPassword } from '../password.ts'
import type { UserRepo } from '../persistence/userRepo.ts'
import type { SessionRepo } from '../persistence/sessionRepo.ts'
import type { HouseholdRepo } from '../persistence/householdRepo.ts'
import type { InviteRepo } from '../persistence/inviteRepo.ts'

const INVITE_TTL_MS = 24 * 60 * 60 * 1000
const REDEEM_IP_MAX = 20
const RATE_WINDOW_MS = 60_000
const MIN_PASSWORD_LEN = 8

const CreateBody = z.object({ kind: z.enum(['join', 'new_household']) }).strict()
const RedeemBody = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(100),
  password: z.string().min(MIN_PASSWORD_LEN).max(1024),
}).strict()

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function generateInviteCode(): string {
  const pick = (n: number) => Array.from(crypto.randomBytes(n), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
  return `${pick(4)}-${pick(4)}`
}

export interface InviteDeps {
  users: UserRepo
  sessions: SessionRepo
  households: HouseholdRepo
  invites: InviteRepo
}

export function registerInvites(app: FastifyInstance, deps: InviteDeps): void {
  const { users, sessions, households, invites } = deps
  const redeemLimiter = new IpRateLimiter(RATE_WINDOW_MS)

  // POST /invites — authenticated. new_household: server owner/admin only.
  // join: household owner (of the target) or server owner/admin.
  app.post('/invites', async (req, reply) => {
    const caller = req.user
    if (!caller) return errorReply(reply, 401, ErrorCodes.UNAUTHORIZED, 'Authentication required')
    const parse = CreateBody.safeParse(req.body)
    if (!parse.success) return badRequest(reply, ErrorCodes.INVALID_INPUT, parse.error.message)
    const { kind } = parse.data

    const callerUser = users.get(caller.id)
    if (!callerUser?.householdId) return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'No household')
    const isServerAdmin = caller.role === 'owner' || caller.role === 'admin'
    const household = households.get(callerUser.householdId)
    const isHouseholdOwner = household?.ownerUserId === caller.id

    if (kind === 'new_household' && !isServerAdmin) {
      return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Only server owner/admin can invite a new household')
    }
    if (kind === 'join' && !isHouseholdOwner && !isServerAdmin) {
      return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Only the household owner can invite members')
    }

    const now = Date.now()
    let code = generateInviteCode()
    for (let i = 0; i < 5; i++) {
      try {
        invites.create({
          code, kind,
          householdId: kind === 'join' ? callerUser.householdId : null,
          createdBy: caller.id, createdAt: now, expiresAt: now + INVITE_TTL_MS,
        })
        break
      } catch { code = generateInviteCode() }
    }
    return { code, expiresAt: now + INVITE_TTL_MS }
  })

  // POST /invites/redeem — unauthenticated, rate-limited.
  app.post('/invites/redeem', async (req, reply) => {
    if (!redeemLimiter.allow(req.ip, REDEEM_IP_MAX)) {
      return errorReply(reply, 429, ErrorCodes.RATE_LIMITED, 'Too many requests')
    }
    const parse = RedeemBody.safeParse(req.body)
    if (!parse.success) {
      const weak = parse.error.issues.some(i => i.path[0] === 'password')
      return badRequest(reply, weak ? ErrorCodes.WEAK_PASSWORD : ErrorCodes.INVALID_INPUT, parse.error.message)
    }
    const { code, name, password } = parse.data

    const inv = invites.get(code)
    if (!inv) return errorReply(reply, 404, ErrorCodes.INVITE_NOT_FOUND, 'Invite not found')
    if (inv.consumedAt != null || inv.expiresAt <= Date.now()) {
      return errorReply(reply, 410, ErrorCodes.INVITE_EXPIRED, 'Invite expired')
    }

    // Resolve the target household.
    const householdId = inv.kind === 'join'
      ? inv.householdId!
      : households.create(name, null).id   // owner set below once we have the user id

    // Duplicate name within the target household → 409.
    if (users.listByHousehold(householdId).some(u => u.name.toLowerCase() === name.toLowerCase())) {
      return errorReply(reply, 409, ErrorCodes.NAME_TAKEN, 'Name already taken in this household')
    }

    const user = users.create({ name, householdId })
    users.setPassword(user.id, await hashPassword(password))
    if (inv.kind === 'new_household') households.setOwner(householdId, user.id)
    invites.consume(code, Date.now())

    const { token } = sessions.issue(user.id, null, [user.id])
    return { token, user: users.get(user.id) }
  })
}
```

> `app.post('/invites', …)` runs under the global `requireAuth` hook (installed by the test / by `server.ts`), so `req.user` is set for authenticated callers. `/invites/redeem` is on the allowlist (Task 9), so it runs unauthenticated.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run src/contexts/identity/infrastructure/http/invites.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/contexts/identity/infrastructure/http/invites.ts apps/server/src/contexts/identity/infrastructure/http/invites.test.ts
git commit -m "feat(server): invite create + redeem routes"
```

---

### Task 11: Households route (`GET /households/me`, `PATCH /households/:id`)

**Files:**
- Create: `apps/server/src/contexts/identity/infrastructure/http/households.ts`
- Test: `apps/server/src/contexts/identity/infrastructure/http/households.test.ts`

- [ ] **Step 1: Write the failing test**

`households.test.ts` (same app-builder pattern as Task 10):

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { openDatabase, type DatabaseSync } from '../../../../platform/db/connection.ts'
import { migrate } from '../../../../platform/db/migrations.ts'
import { createUserRepo } from '../persistence/userRepo.ts'
import { createSessionRepo } from '../persistence/sessionRepo.ts'
import { createHouseholdRepo } from '../persistence/householdRepo.ts'
import { ensureHouseholds } from '../../domain/household.ts'
import { makeRequireAuth } from '../authMiddleware.ts'
import { registerHouseholds } from './households.ts'

async function makeApp() {
  const db: DatabaseSync = openDatabase(':memory:')
  migrate(db)
  const users = createUserRepo(db); const sessions = createSessionRepo(db); const households = createHouseholdRepo(db)
  const owner = users.create({ name: 'Owner' }); ensureHouseholds(db)
  users.create({ name: 'Partner', householdId: users.get(owner.id)!.householdId })
  const token = sessions.issue(owner.id).token
  const app = Fastify()
  app.addHook('onRequest', makeRequireAuth(sessions, users))
  registerHouseholds(app, { users, households })
  await app.ready()
  return { app, owner, token, users, households }
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` })

describe('households', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>
  beforeEach(async () => { ctx = await makeApp() })

  it('GET /households/me returns the household + its members', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/households/me', headers: auth(ctx.token) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.members.map((m: any) => m.name).sort()).toEqual(['Owner', 'Partner'])
    expect(body.ownerUserId).toBe(ctx.owner.id)
  })

  it('PATCH /households/:id rename by the owner', async () => {
    const id = ctx.users.get(ctx.owner.id)!.householdId
    const res = await ctx.app.inject({ method: 'PATCH', url: `/households/${id}`, headers: auth(ctx.token), payload: { name: 'Living Room' } })
    expect(res.statusCode).toBe(200)
    expect(ctx.households.get(id)!.name).toBe('Living Room')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/contexts/identity/infrastructure/http/households.test.ts`
Expected: FAIL — `registerHouseholds` undefined.

- [ ] **Step 3: Implement**

`households.ts`:

```typescript
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ErrorCodes } from '@horizon/sdk'
import { errorReply, badRequest, sendNotFound } from '../../../../platform/http/errors.ts'
import type { UserRepo } from '../persistence/userRepo.ts'
import type { HouseholdRepo } from '../persistence/householdRepo.ts'

const RenameBody = z.object({ name: z.string().min(1).max(100) }).strict()

export function registerHouseholds(
  app: FastifyInstance,
  deps: { users: UserRepo; households: HouseholdRepo },
): void {
  const { users, households } = deps

  app.get('/households/me', async (req, reply) => {
    const caller = req.user
    if (!caller) return errorReply(reply, 401, ErrorCodes.UNAUTHORIZED, 'Authentication required')
    const me = users.get(caller.id)
    if (!me?.householdId) return errorReply(reply, 404, ErrorCodes.NOT_FOUND, 'No household')
    const household = households.get(me.householdId)
    if (!household) return sendNotFound(reply, ErrorCodes.NOT_FOUND, 'Household not found')
    return {
      id: household.id,
      name: household.name,
      ownerUserId: household.ownerUserId,
      members: users.listByHousehold(household.id),
    }
  })

  app.patch('/households/:id', async (req, reply) => {
    const caller = req.user
    if (!caller) return errorReply(reply, 401, ErrorCodes.UNAUTHORIZED, 'Authentication required')
    const id = (req.params as { id: string }).id
    const parse = RenameBody.safeParse(req.body)
    if (!parse.success) return badRequest(reply, ErrorCodes.INVALID_INPUT, parse.error.message)
    const household = households.get(id)
    if (!household) return sendNotFound(reply, ErrorCodes.NOT_FOUND, 'Household not found')
    const isServerAdmin = caller.role === 'owner' || caller.role === 'admin'
    if (household.ownerUserId !== caller.id && !isServerAdmin) {
      return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Only the household owner can rename it')
    }
    households.rename(id, parse.data.name)
    return { id, name: parse.data.name, ownerUserId: household.ownerUserId }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run src/contexts/identity/infrastructure/http/households.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/contexts/identity/infrastructure/http/households.ts apps/server/src/contexts/identity/infrastructure/http/households.test.ts
git commit -m "feat(server): households route (me + rename)"
```

---

### Task 12: Pairing grant + `GET /auth/grant` + poll returns profiles

**Files:**
- Modify: `apps/server/src/contexts/identity/infrastructure/http/auth.ts`
- Test: `apps/server/src/contexts/identity/infrastructure/http/auth.test.ts`

**Context:** `auth.ts` already has `/auth/pair/approve` and `/auth/pair/poll`. This task: (a) `approve` accepts `grant: userId[]`, validates it against the approver's household (owner → any subset of household; member → self only; default fills), stores it; (b) `poll` issues the session with that grant and returns granted `profiles` objects; (c) new `GET /auth/grant` returns the caller's granted profiles. The grant validation is a pure helper so it is unit-testable.

- [ ] **Step 1: Write the failing test**

Append to `auth.test.ts`:

```typescript
import { validateGrant } from './auth.ts'

describe('validateGrant', () => {
  const members = ['owner', 'partner', 'kid']
  it('owner: omitted grant fills to all household members', () => {
    expect(validateGrant({ approverId: 'owner', isHouseholdOwner: true, householdMemberIds: members, requested: undefined }))
      .toEqual({ ok: true, grant: members })
  })
  it('owner: explicit subset allowed', () => {
    expect(validateGrant({ approverId: 'owner', isHouseholdOwner: true, householdMemberIds: members, requested: ['owner', 'partner'] }))
      .toEqual({ ok: true, grant: ['owner', 'partner'] })
  })
  it('owner: id outside the household rejected', () => {
    expect(validateGrant({ approverId: 'owner', isHouseholdOwner: true, householdMemberIds: members, requested: ['owner', 'stranger'] }).ok)
      .toBe(false)
  })
  it('member: only self allowed; omitted → self', () => {
    expect(validateGrant({ approverId: 'partner', isHouseholdOwner: false, householdMemberIds: members, requested: undefined }))
      .toEqual({ ok: true, grant: ['partner'] })
    expect(validateGrant({ approverId: 'partner', isHouseholdOwner: false, householdMemberIds: members, requested: ['owner'] }).ok)
      .toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/contexts/identity/infrastructure/http/auth.test.ts`
Expected: FAIL — `validateGrant` not exported.

- [ ] **Step 3: Implement**

In `auth.ts`, add the pure helper (export it):

```typescript
export interface GrantCheck {
  approverId: string
  isHouseholdOwner: boolean
  householdMemberIds: string[]
  requested: string[] | undefined
}

/** Validate/normalize the act-as grant an approver may attach to a device. */
export function validateGrant(c: GrantCheck): { ok: true; grant: string[] } | { ok: false } {
  if (!c.isHouseholdOwner) {
    // Members may grant only themselves.
    if (c.requested && !(c.requested.length === 1 && c.requested[0] === c.approverId)) return { ok: false }
    return { ok: true, grant: [c.approverId] }
  }
  // Household owner: default to the whole household; any explicit id must be in it.
  if (c.requested === undefined) return { ok: true, grant: c.householdMemberIds }
  if (c.requested.some(id => !c.householdMemberIds.includes(id))) return { ok: false }
  return { ok: true, grant: c.requested }
}
```

Wire it into `/auth/pair/approve`. Locate the existing approve handler. After it loads the pairing code and the approver (`caller`), compute the household + members and validate, then store the grant. Replace the `sessions.approvePairingCode(parse.data.code, caller.id)` call with grant-aware logic. The handler needs `users` + `households` repos — extend `registerAuth`'s signature to accept them (it currently takes `(app, users, sessions)`; add `households`). Update the approve body schema to include an optional `grant`:

```typescript
const PairApproveBody = z.object({
  code: z.string().min(1).max(32),
  grant: z.array(z.string()).optional(),
}).strict()
```

Inside approve, after validating the code is live:

```typescript
    const approver = users.get(caller.id)
    if (!approver?.householdId) return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'No household')
    const household = households.get(approver.householdId)
    const memberIds = users.listByHousehold(approver.householdId).map(u => u.id)
    const check = validateGrant({
      approverId: caller.id,
      isHouseholdOwner: household?.ownerUserId === caller.id,
      householdMemberIds: memberIds,
      requested: parse.data.grant,
    })
    if (!check.ok) return errorReply(reply, 403, ErrorCodes.GRANT_FORBIDDEN, 'Cannot grant those profiles')
    sessions.approvePairingCode(parse.data.code, caller.id, check.grant)
    return { ok: true }
```

In `/auth/pair/poll`, when it issues the session, pass the stored grant and return the granted profile objects. Locate the `sessions.issue(pc.approvedUserId, …)` call and change it to:

```typescript
    const grant = pc.grantedUserIds ?? [pc.approvedUserId]
    const ua = req.headers['user-agent']
    const { token, session } = sessions.issue(pc.approvedUserId, typeof ua === 'string' ? ua : null, grant)
    sessions.consumePairingCode(parse.data.code, session.id)
    const profiles = grant.map(id => users.get(id)).filter(Boolean).map(u => ({ id: u!.id, name: u!.name, avatar: u!.avatar }))
    return { token, user: users.get(pc.approvedUserId), grant, profiles }
```

In `/auth/login`, stamp a self-only grant: change `sessions.issue(auth.id, …)` to `sessions.issue(auth.id, …, [auth.id])`.

Add `GET /auth/grant` (authenticated): returns the caller's granted profiles, intersected with their current household (finding A + F):

```typescript
  app.get('/auth/grant', async (req, reply) => {
    const caller = req.user
    if (!caller) return errorReply(reply, 401, ErrorCodes.UNAUTHORIZED, 'Authentication required')
    const token = tokenFromRequest(req)
    const session = token ? sessions.resolve(token) : null
    const grant = session?.grant ?? [caller.id]
    const me = users.get(caller.id)
    const householdId = me?.householdId
    const profiles = grant
      .map(id => users.get(id))
      .filter((u): u is NonNullable<typeof u> => !!u && u.householdId === householdId)
      .map(u => ({ id: u.id, name: u.name, avatar: u.avatar }))
    return { profiles }
  })
```

Ensure `tokenFromRequest` is imported in `auth.ts` (from `../authMiddleware.ts`), and `households`/`users` repos are threaded through `registerAuth`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run src/contexts/identity/infrastructure/http/auth.test.ts`
Expected: PASS (the existing auth tests must also stay green — update the `registerAuth(app, users, sessions)` call sites in those tests to pass `households` too; build a `createHouseholdRepo(db)` in their setup).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/contexts/identity/infrastructure/http/auth.ts apps/server/src/contexts/identity/infrastructure/http/auth.test.ts
git commit -m "feat(server): pairing grant validation, /auth/grant, poll returns profiles"
```

---

### Task 13: Household-scope `GET /users`

**Files:**
- Modify: `apps/server/src/contexts/identity/infrastructure/http/users.ts`
- Test: `apps/server/src/contexts/identity/infrastructure/http/users.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `users.test.ts` an authenticated case asserting `GET /users` returns only the caller's household members (create two households; the caller in one should not see the other's members). Mirror the file's existing app-builder/auth setup.

```typescript
it('authenticated GET /users returns only the caller household members', async () => {
  // ctx setup: owner in Home, plus a friend in another household
  const friendHousehold = ctx.households.create('Friend', null).id
  ctx.users.create({ name: 'Friend', householdId: friendHousehold })
  const res = await ctx.app.inject({ method: 'GET', url: '/users', headers: auth(ctx.ownerToken) })
  expect(res.statusCode).toBe(200)
  expect(res.json().map((u: any) => u.name)).not.toContain('Friend')
})
```

> Adapt to how `users.test.ts` builds its app/context. If the existing GET /users test asserts the full list pre-auth, keep that (unauthenticated path is unchanged) and add this authenticated, scoped case.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/contexts/identity/infrastructure/http/users.test.ts`
Expected: FAIL — scoped list returns all users.

- [ ] **Step 3: Implement**

In `users.ts`, find the `GET /users` handler. When the request is authenticated (`req.user` set), return only that household's members; otherwise keep the existing full list (the unauthenticated web login picker). Concretely:

```typescript
  app.get('/users', async (req) => {
    const caller = req.user
    if (caller) {
      const me = users.get(caller.id)
      if (me?.householdId) return users.listByHousehold(me.householdId)
    }
    return users.list()
  })
```

> Match the existing handler's exact shape/return (it may already return `users.list()` directly); only add the authenticated household-scoping branch.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run src/contexts/identity/infrastructure/http/users.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/contexts/identity/infrastructure/http/users.ts apps/server/src/contexts/identity/infrastructure/http/users.test.ts
git commit -m "feat(server): household-scope authenticated GET /users"
```

---

### Task 14: Per-user routes act on `profileUserId`

**Files:**
- Modify: `apps/server/src/contexts/playback/` progress + sessions HTTP adapters (the files registering `/users/:id/continue-watching`, `/users/:id/progress/*`, `POST /sessions`).
- Test: their co-located `*.test.ts`.

**Context:** First locate the routes — `grep -rn "continue-watching\|/progress/\|POST.*sessions\|profileUserId\|X-Horizon" apps/server/src/contexts/playback`. These handlers currently derive the acting user from the `:userId` path param (and previously the `X-Horizon-User` header). They must use `req.profileUserId` (set by `resolveProfile`) as the acting user, and reject when the path `:userId` disagrees with `req.profileUserId`.

- [ ] **Step 1: Write the failing test**

In the progress route test, add a case: a session granted `['principal','partner']`, request `GET /users/partner/continue-watching` with `X-Horizon-Profile: partner` succeeds and reads partner's data; the same with `X-Horizon-Profile: stranger` is rejected upstream by `resolveProfile` (covered in Task 9) — here assert that when `req.profileUserId` is `partner`, the handler keys off it (not the path). If the route's test harness installs `resolveProfile`, assert the 403 path too.

```typescript
it('continue-watching keys off the active profile, not the path :userId', async () => {
  // ctx: session grant = [principal, partner]; partner has one in-progress item
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/users/partner/continue-watching',
    headers: { authorization: `Bearer ${ctx.token}`, 'x-horizon-profile': 'partner' },
  })
  expect(res.statusCode).toBe(200)
  expect(res.json().length).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run <the progress route test path>`
Expected: FAIL (or wrong user's data) until the handler uses `req.profileUserId`.

- [ ] **Step 3: Implement**

In each per-user handler, replace the acting-user derivation with `req.profileUserId` and validate path agreement. Pattern:

```typescript
    const actingUserId = req.profileUserId
    if (!actingUserId) return errorReply(reply, 401, ErrorCodes.UNAUTHORIZED, 'Authentication required')
    const pathUserId = (req.params as { userId: string }).userId
    if (pathUserId !== actingUserId) {
      return errorReply(reply, 403, ErrorCodes.USER_MISMATCH, 'Profile mismatch')
    }
    // …use actingUserId everywhere the handler previously used the path/header user…
```

For `POST /sessions` (which takes `userId` in the body), use `req.profileUserId` as the session's user when present, validating it matches any body `userId`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run <the progress route test path>`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/contexts/playback
git commit -m "feat(server): per-user routes act on resolved profile, not path/header"
```

---

# Phase 5 — Wiring & integration

### Task 15: Barrel exports

**Files:**
- Modify: `apps/server/src/contexts/identity/index.ts`

- [ ] **Step 1: Implement (consumed by Task 16; typecheck verifies)**

Add to `apps/server/src/contexts/identity/index.ts`:

```typescript
export { createHouseholdRepo, type HouseholdRepo, type Household } from './infrastructure/persistence/householdRepo.ts'
export { createInviteRepo, type InviteRepo, type Invite, type InviteKind } from './infrastructure/persistence/inviteRepo.ts'
export { ensureHouseholds } from './domain/household.ts'
export { registerInvites, type InviteDeps } from './infrastructure/http/invites.ts'
export { registerHouseholds } from './infrastructure/http/households.ts'
export { makeResolveProfile, PROFILE_HEADER } from './infrastructure/authMiddleware.ts'
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/server && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/contexts/identity/index.ts
git commit -m "feat(server): export households/invites/act-as from identity barrel"
```

---

### Task 16: Wire into server.ts + bootstrap

**Files:**
- Modify: `apps/server/src/platform/http/server.ts`
- Modify: `apps/server/src/platform/composition/bootstrap.ts`
- Test: `apps/server/src/platform/http/server.ts` is exercised by existing integration tests + a new smoke assertion.

- [ ] **Step 1: Wire the composition root**

In `bootstrap.ts`:
- Import from the identity barrel: `createHouseholdRepo`, `createInviteRepo`, `ensureHouseholds`.
- After `migrate(db)` and after the user repo is created, call `ensureHouseholds(db)`.
- Build `const households = createHouseholdRepo(db)` and `const invites = createInviteRepo(db)` alongside the other repos, and pass them into `buildServer` (extend the repos/deps object — see next step).

In `server.ts`:
- Extend `registerAuth(api, repos.userRepo, repos.sessionRepo)` → `registerAuth(api, repos.userRepo, repos.sessionRepo, repos.householdRepo)` (Task 12 added the `households` param).
- After `registerUsers(...)`, add:

```typescript
    registerInvites(api, { users: repos.userRepo, sessions: repos.sessionRepo, households: repos.householdRepo, invites: repos.inviteRepo })
    registerHouseholds(api, { users: repos.userRepo, households: repos.householdRepo })
```

- Install the `resolveProfile` hook right after the `requireAuth` hook is added:

```typescript
    const resolveProfile = makeResolveProfile(repos.sessionRepo, repos.userRepo)
    api.addHook('preHandler', resolveProfile)
```

- Add `householdRepo: HouseholdRepo` and `inviteRepo: InviteRepo` to the `Repos` interface and import `registerInvites`, `registerHouseholds`, `makeResolveProfile`, `createHouseholdRepo`/types from `../../contexts/identity/index.ts`.

- [ ] **Step 2: Add a smoke test**

Add to `apps/server/src/platform/http/health.test.ts` (it already boots a real server) a new case asserting the new routes are registered, e.g. `GET /api/households/me` without a token returns 401 (route exists, guarded) rather than 404:

```typescript
it('households route is registered under /api (guarded)', async () => {
  const app = await makeApp()
  const res = await app.inject({ method: 'GET', url: '/api/households/me' })
  expect(res.statusCode).toBe(401)   // exists but requires auth (not 404)
  await app.close()
})
```

> Update `makeApp` in that test to construct + pass `householdRepo` and `inviteRepo` (and the extra `registerAuth` arg) to match the new `buildServer`/`Repos` shape.

- [ ] **Step 3: Typecheck + run the wiring test**

Run: `cd apps/server && npx tsc --noEmit && npx vitest run src/platform/http/health.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/platform/http/server.ts apps/server/src/platform/composition/bootstrap.ts apps/server/src/platform/http/health.test.ts
git commit -m "feat(server): register invites/households + resolveProfile; ensureHouseholds on boot"
```

---

### Task 17: First-boot owner gets a household

**Files:**
- Modify: wherever the first-boot owner is created (`grep -rn "auto-elect\|first.*owner\|length === 0" apps/server/src/contexts/identity`).
- Test: the user-creation route test (`users.test.ts`).

**Context:** The first profile created (auto-elected owner) must land in a Home household so subsequent act-as/scoping works without waiting for a restart's `ensureHouseholds`. Easiest: after the first user is created via `POST /users`, if they have no household, run `ensureHouseholds(db)` (idempotent) — but the route may not hold `db`. Alternative: in the user-create handler, when the created user is the first/owner, create a Home household and assign. Prefer calling `ensureHouseholds` if `db` is reachable in that context; otherwise inject a small `onFirstOwner` callback.

- [ ] **Step 1: Write the failing test**

In `users.test.ts`, assert that the first created user has a non-null `householdId` and is the owner of a household:

```typescript
it('first-boot owner is placed in a Home household they own', async () => {
  // create the very first user via POST /users (unauthenticated first-boot path)
  const res = await ctx.app.inject({ method: 'POST', url: '/users', payload: { name: 'Owner' } })
  expect(res.statusCode).toBe(200)
  const id = res.json().id
  const u = ctx.users.get(id)!
  expect(u.householdId).not.toBeNull()
  expect(ctx.households.get(u.householdId!)!.ownerUserId).toBe(id)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/contexts/identity/infrastructure/http/users.test.ts`
Expected: FAIL — new owner has null household.

- [ ] **Step 3: Implement**

Thread a `households` repo into `registerUsers` and, in the create handler, after creating a user when `users.list().length === 1` (the just-created owner), create a Home household and assign:

```typescript
    const created = users.create({ name, /* … */ })
    if (users.list().length === 1) {
      const home = households.create('Home', created.id)
      users.setHousehold(created.id, home.id)
      return users.get(created.id)   // return the household-assigned user
    }
```

> Match the handler's existing return shape. Pass `households` from `server.ts`'s `registerUsers(api, repos.userRepo, repos.sessionRepo)` call → add `repos.householdRepo`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run src/contexts/identity/infrastructure/http/users.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/contexts/identity/infrastructure/http/users.ts apps/server/src/platform/http/server.ts apps/server/src/contexts/identity/infrastructure/http/users.test.ts
git commit -m "feat(server): first-boot owner placed in a Home household"
```

---

### Task 18: WebSocket upgrade auth (finding D) + full-suite green

**Files:**
- Test: the progress WebSocket route test in `apps/server/src/contexts/playback/`.

**Context:** Confirm the progress WS upgrade is NOT allowlisted and rejects a missing/invalid Bearer token. The global `requireAuth` runs on the upgrade request; verify (don't assume).

- [ ] **Step 1: Write the failing/guard test**

Locate the WS route (`grep -rn "websocket\|wsUrl\|/sessions/.*ws\|@fastify/websocket" apps/server/src/contexts/playback`). Add a test that opens the WS upgrade without a token and expects a non-101 (rejected) response. Use the pattern the existing WS tests use (`app.inject` with `upgrade` headers, or the project's WS test helper). Example shape:

```typescript
it('progress WS upgrade without a token is rejected', async () => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/api/sessions/SOME_ID/progress',   // the real WS path
    headers: { connection: 'upgrade', upgrade: 'websocket' },
  })
  expect(res.statusCode).not.toBe(101)
  expect([401, 400, 426]).toContain(res.statusCode)
})
```

- [ ] **Step 2: Run test**

Run: `cd apps/server && npx vitest run <ws test path>`
Expected: PASS if the guard already covers the upgrade. If it FAILS (upgrade bypasses auth), add the WS path to neither allowlist and ensure `requireAuth` runs on it — then re-run.

- [ ] **Step 3: Full suite + typecheck**

Run: `cd apps/server && npx tsc --noEmit && npx vitest run`
Expected: ALL pass (every prior `registerAuth`/`buildServer` call-site updated; no `X-Horizon-User` remains).

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/contexts/playback
git commit -m "test(server): assert progress WS upgrade requires auth"
```

---

## Final verification

- [ ] `cd apps/server && npx tsc --noEmit` → clean.
- [ ] `cd apps/server && npx vitest run` → all pass (existing suite + new household/invite/act-as tests).
- [ ] `grep -rn "[Xx]-[Hh]orizon-[Uu]ser" apps/server/src libs/sdk/src` → no matches (legacy header fully removed).
- [ ] Manual boot smoke: `cd apps/server && timeout 6 npm start 2>&1 | head` → boots, `ensureHouseholds` runs without error.

## Notes for the implementer

- Several tasks extend existing route registrar signatures (`registerAuth`, `registerUsers`). When you change a signature, update **every** call site (other route files' tests + `server.ts`) in the same task so the suite stays green — the spec's regression requirement (existing tests pass) is a hard gate.
- The web client + Android client are separate specs; do not touch `apps/web` or `apps/android-tv` here.
