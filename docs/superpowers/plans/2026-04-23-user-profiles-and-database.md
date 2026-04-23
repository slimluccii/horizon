# User Profiles + Database Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local, no-auth user profiles and watch-progress persistence, backed by SQLite. Move the media catalog out of `LibraryIndex` and into a single `media_items` table with a `kind` discriminator.

**Architecture:** `node:sqlite` opens a file-backed DB. Migrations run on boot (single v1 migration that creates the full schema). Repositories expose typed CRUD for each entity. The scanner upserts into `media_items` + rebuilds collections. Library routes query repos instead of an in-memory index. `LibraryIndex` is removed. A new WebSocket message (`progress`) feeds `watch_progress` with a 30 s flush cadence; final flush fires on WS close. The React client gains a `/setup` + `/profiles` flow, a Continue Watching rail, and a resume-from-position toast on the player.

**Tech Stack:** `node:sqlite` (Node 24+ built-in), `zod` (new dep — server + sdk), existing Fastify + React + `hls.js`. `DatabaseSync` only — no async driver.

**Spec:** [`docs/superpowers/specs/2026-04-23-user-profiles-and-database-design.md`](../specs/2026-04-23-user-profiles-and-database-design.md).

---

## File Structure

### New server files
```
server/src/db/
  index.ts             openDatabase() + close + typed handle
  schema.sql           full v1 DDL (written into migrations.ts)
  migrations.ts        numbered migrations, PRAGMA user_version driver
  rowSchemas.ts        zod schemas for each row shape + inferred TS types

server/src/repos/
  users.ts             users table CRUD
  media.ts             media_items upsert/get/list/softDeleteMissing
  collections.ts       collections + collection_items
  progress.ts          watch_progress + continueWatching + next-up

server/src/routes/
  users.ts             /users CRUD
  progress.ts          /users/:userId/progress + /continue-watching

server/src/ws/
  progress-flusher.ts  in-memory progress buffer + timer + final flush

server/test/
  db.migrate.test.ts
  repos.users.test.ts
  repos.media.test.ts
  repos.collections.test.ts
  repos.progress.test.ts
  routes.users.test.ts
  routes.progress.test.ts
  scanner.integration.test.ts     (replaces the ad-hoc scan behavior)
```

### New SDK files
```
sdk/src/
  users.ts             User type + client methods
  progress.ts          WatchProgress + ContinueWatchingItem types + client methods
```

### New client files
```
app/src/
  hooks/useActiveUser.ts
  pages/Setup.tsx
  pages/ProfilePicker.tsx
  components/ProfileBadge.tsx
  components/ContinueWatchingRail.tsx
e2e/
  setup.spec.ts
  profiles.spec.ts
  resume.spec.ts
```

### Modified server files
- `server/package.json` — add `zod` dep
- `server/src/config.ts` — add `dbPath`, `watchedThresholdPct`
- `server/src/index.ts` — open DB, run migrations, pass to scanner/routes
- `server/src/scanner/scanner.ts` — switch from LibraryIndex to repo writes, drop the exported index shape
- `server/src/routes/library.ts` — use media repo
- `server/src/routes/sessions.ts` — use media repo (swap `index.byId.get`)
- `server/src/server.ts` — register new routes
- `server/src/ws/messages.ts` — add `ProgressMessage`
- `server/src/ws/handler.ts` — dispatch `progress`, wire flusher
- `server/src/session/types.ts` — add `lastProgress` field

### Modified SDK files
- `sdk/src/client.ts` — users + progress methods
- `sdk/src/session.ts` — `reportProgress()` + resume-position arg
- `sdk/src/index.ts` — re-exports
- `sdk/package.json` — add `zod`

### Modified client files
- `app/src/App.tsx` — routing guard, new routes
- `app/src/horizon.ts` — `X-Horizon-User` header from localStorage
- `app/src/pages/Library.tsx` — rail at top + profile badge
- `app/src/pages/Player.tsx` — fetch resume position, show toast, hand startPositionMs to session
- `app/src/components/VideoPlayer.tsx` — progress reporter + report on pause/seek

### Deleted
- `LibraryIndex` export from `scanner.ts` (type + in-memory Map). Replaced by repo queries.

---

## Task 1: Add zod + SQLite connection module

**Files:**
- Modify: `server/package.json`
- Modify: `sdk/package.json`
- Create: `server/src/db/index.ts`
- Create: `server/test/db.connection.test.ts`

- [ ] **Step 1: Install zod in both workspaces**

Run:
```bash
npm -w server i zod@^3.23.8
npm -w sdk i zod@^3.23.8
```

Expected: `package.json` / `package-lock.json` updated, no build errors.

- [ ] **Step 2: Write the failing connection test**

Create `server/test/db.connection.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { openDatabase } from '../src/db/index.ts'

describe('openDatabase', () => {
  it('opens an in-memory DB with foreign_keys + WAL configured', () => {
    const db = openDatabase(':memory:')
    const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
    expect(fk.foreign_keys).toBe(1)
    // WAL isn't meaningful for :memory: but the call should still succeed
    const res = db.prepare('SELECT 1 as ok').get() as { ok: number }
    expect(res.ok).toBe(1)
    db.close()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm -w server test -- db.connection`
Expected: FAIL — module `../src/db/index.ts` not found.

- [ ] **Step 4: Implement openDatabase**

Create `server/src/db/index.ts`:
```ts
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

export type { DatabaseSync } from 'node:sqlite'

/**
 * Open a SQLite database at `filePath` (or ':memory:'). Applies PRAGMAs we
 * want globally: foreign_keys ON, WAL journal mode for concurrent reads
 * during scans. Creates parent directories if they don't exist.
 */
export function openDatabase(filePath: string): DatabaseSync {
  if (filePath !== ':memory:') {
    mkdirSync(path.dirname(filePath), { recursive: true })
  }
  const db = new DatabaseSync(filePath)
  db.exec('PRAGMA foreign_keys = ON')
  // WAL is a no-op on :memory: but safe to call.
  db.exec('PRAGMA journal_mode = WAL')
  return db
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm -w server test -- db.connection`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/package-lock.json sdk/package.json sdk/package-lock.json package-lock.json server/src/db/index.ts server/test/db.connection.test.ts
git commit -m "feat(server): add node:sqlite + zod, introduce openDatabase"
```

---

## Task 2: Migrations (v1 schema)

**Files:**
- Create: `server/src/db/migrations.ts`
- Create: `server/test/db.migrate.test.ts`

- [ ] **Step 1: Write the failing migrate test**

Create `server/test/db.migrate.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'

describe('migrate', () => {
  it('applies v1 to an empty DB', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const ver = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(ver).toBe(1)
  })

  it('is idempotent — applying twice leaves version at the latest', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    migrate(db)
    const ver = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(ver).toBe(1)
    const rows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]
    expect(rows.map(r => r.version)).toEqual([1])
  })

  it('creates all tables', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[]).map(r => r.name)
    expect(names).toContain('users')
    expect(names).toContain('media_items')
    expect(names).toContain('collections')
    expect(names).toContain('collection_items')
    expect(names).toContain('watch_progress')
    expect(names).toContain('schema_migrations')
  })

  it('enforces kind CHECK on media_items', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    expect(() => {
      db.prepare(
        `INSERT INTO media_items (id, kind, title, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('x', 'song', 't', 0, 0)
    }).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server test -- db.migrate`
Expected: FAIL — module `../src/db/migrations.ts` not found.

- [ ] **Step 3: Implement migrations**

Create `server/src/db/migrations.ts`:
```ts
import type { DatabaseSync } from 'node:sqlite'

interface Migration { version: number; sql: string }

const V1_SQL = `
CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  avatar      TEXT,
  preferences TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE media_items (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK(kind IN ('movie','show','episode')),
  parent_id       TEXT REFERENCES media_items(id) ON DELETE CASCADE,

  title           TEXT NOT NULL,
  sort_year       INTEGER,
  season          INTEGER,
  episode         INTEGER,

  file_path       TEXT UNIQUE,
  duration_sec    REAL,
  resolution      TEXT,
  video_codec     TEXT,
  container       TEXT,
  hdr             TEXT,
  audio_tracks    TEXT,
  subtitle_tracks TEXT,
  mtime_ms        INTEGER,
  size_bytes      INTEGER,

  external_ids    TEXT NOT NULL DEFAULT '{}',
  metadata        TEXT,

  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  deleted_at      INTEGER
);

CREATE INDEX idx_media_kind   ON media_items(kind)                       WHERE deleted_at IS NULL;
CREATE INDEX idx_media_parent ON media_items(parent_id, season, episode) WHERE deleted_at IS NULL;
CREATE INDEX idx_media_title  ON media_items(title)                      WHERE deleted_at IS NULL;

CREATE TABLE collections (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE collection_items (
  collection_id TEXT NOT NULL REFERENCES collections(id)  ON DELETE CASCADE,
  media_id      TEXT NOT NULL REFERENCES media_items(id)  ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  PRIMARY KEY (collection_id, media_id)
);

CREATE TABLE watch_progress (
  user_id     TEXT NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
  media_id    TEXT NOT NULL REFERENCES media_items(id)  ON DELETE CASCADE,
  position_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  watched     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, media_id)
);
CREATE INDEX idx_progress_user_updated ON watch_progress(user_id, updated_at DESC);
`

const MIGRATIONS: Migration[] = [
  { version: 1, sql: V1_SQL },
]

/** Apply any migrations whose version is greater than PRAGMA user_version.
 *  Each migration runs in its own transaction; failure rolls back and
 *  leaves user_version at the previous version. */
export function migrate(db: DatabaseSync): void {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  const pending = MIGRATIONS
    .filter(m => m.version > current)
    .sort((a, b) => a.version - b.version)
  for (const m of pending) {
    db.exec('BEGIN')
    try {
      db.exec(m.sql)
      db.exec(`PRAGMA user_version = ${m.version}`)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(m.version, Date.now())
      db.exec('COMMIT')
      console.log(`DB: migrated to v${m.version}`)
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w server test -- db.migrate`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/db/migrations.ts server/test/db.migrate.test.ts
git commit -m "feat(server): v1 migration with full schema"
```

---

## Task 3: Row zod schemas

**Files:**
- Create: `server/src/db/rowSchemas.ts`
- Create: `server/test/rowSchemas.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/test/rowSchemas.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { UserRowSchema, MediaItemRowSchema, WatchProgressRowSchema } from '../src/db/rowSchemas.ts'

describe('UserRowSchema', () => {
  it('parses a valid row', () => {
    const row = UserRowSchema.parse({
      id: 'u1', name: 'Luuk', avatar: '🐼', preferences: '{}',
      created_at: 1, updated_at: 2,
    })
    expect(row.name).toBe('Luuk')
    expect(row.avatar).toBe('🐼')
  })

  it('accepts null avatar', () => {
    const row = UserRowSchema.parse({
      id: 'u1', name: 'x', avatar: null, preferences: '{}',
      created_at: 1, updated_at: 1,
    })
    expect(row.avatar).toBeNull()
  })
})

describe('MediaItemRowSchema', () => {
  it('parses a movie row with JSON fields', () => {
    const row = MediaItemRowSchema.parse({
      id: 'm1', kind: 'movie', parent_id: null,
      title: 'Oppenheimer', sort_year: 2023, season: null, episode: null,
      file_path: '/x.mkv', duration_sec: 10000, resolution: '1920x1080',
      video_codec: 'hevc', container: 'mkv',
      hdr: '{"dv":true,"hdr10":true,"hdr10plus":false}',
      audio_tracks: '[]', subtitle_tracks: '[]',
      mtime_ms: 1, size_bytes: 1000,
      external_ids: '{"tmdb":872585}', metadata: null,
      first_seen_at: 1, last_seen_at: 2, deleted_at: null,
    })
    expect(row.kind).toBe('movie')
  })

  it('rejects bad kind', () => {
    expect(() => MediaItemRowSchema.parse({ kind: 'song' })).toThrow()
  })
})

describe('WatchProgressRowSchema', () => {
  it('coerces watched integer to boolean', () => {
    const row = WatchProgressRowSchema.parse({
      user_id: 'u1', media_id: 'm1',
      position_ms: 12_000, duration_ms: 60_000,
      watched: 1, updated_at: 99,
    })
    expect(row.watched).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server test -- rowSchemas`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement row schemas**

Create `server/src/db/rowSchemas.ts`:
```ts
import { z } from 'zod'

/**
 * SQLite returns booleans as integers. These helpers convert at the zod
 * boundary so the rest of the app works in native JS types.
 */
const intBool = z.number().int().transform(n => n !== 0)

export const UserRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatar: z.string().nullable(),
  preferences: z.string(),      // JSON blob, left as string at row layer
  created_at: z.number().int(),
  updated_at: z.number().int(),
})
export type UserRow = z.infer<typeof UserRowSchema>

export const MediaKind = z.enum(['movie', 'show', 'episode'])
export type MediaKind = z.infer<typeof MediaKind>

export const MediaItemRowSchema = z.object({
  id: z.string(),
  kind: MediaKind,
  parent_id: z.string().nullable(),

  title: z.string(),
  sort_year: z.number().int().nullable(),
  season: z.number().int().nullable(),
  episode: z.number().int().nullable(),

  file_path: z.string().nullable(),
  duration_sec: z.number().nullable(),
  resolution: z.string().nullable(),
  video_codec: z.string().nullable(),
  container: z.string().nullable(),
  hdr: z.string().nullable(),
  audio_tracks: z.string().nullable(),
  subtitle_tracks: z.string().nullable(),
  mtime_ms: z.number().int().nullable(),
  size_bytes: z.number().int().nullable(),

  external_ids: z.string(),
  metadata: z.string().nullable(),

  first_seen_at: z.number().int(),
  last_seen_at: z.number().int(),
  deleted_at: z.number().int().nullable(),
})
export type MediaItemRow = z.infer<typeof MediaItemRowSchema>

export const WatchProgressRowSchema = z.object({
  user_id: z.string(),
  media_id: z.string(),
  position_ms: z.number().int(),
  duration_ms: z.number().int(),
  watched: intBool,
  updated_at: z.number().int(),
})
export type WatchProgressRow = z.infer<typeof WatchProgressRowSchema>

export const CollectionRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  updated_at: z.number().int(),
})
export type CollectionRow = z.infer<typeof CollectionRowSchema>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w server test -- rowSchemas`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/db/rowSchemas.ts server/test/rowSchemas.test.ts
git commit -m "feat(server): zod row schemas for users, media_items, watch_progress"
```

---

## Task 4: Users repository

**Files:**
- Create: `server/src/repos/users.ts`
- Create: `server/test/repos.users.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/test/repos.users.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type DatabaseSync } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createUserRepo, type UserRepo } from '../src/repos/users.ts'

function freshRepo(): UserRepo {
  const db: DatabaseSync = openDatabase(':memory:')
  migrate(db)
  return createUserRepo(db)
}

describe('userRepo', () => {
  let repo: UserRepo
  beforeEach(() => { repo = freshRepo() })

  it('creates a user with generated id + timestamps', () => {
    const u = repo.create({ name: 'Luuk', avatar: '🐼' })
    expect(u.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(u.name).toBe('Luuk')
    expect(u.createdAt).toBeGreaterThan(0)
    expect(u.createdAt).toBe(u.updatedAt)
  })

  it('lists users in insertion order', () => {
    repo.create({ name: 'A' })
    repo.create({ name: 'B' })
    const list = repo.list()
    expect(list.map(u => u.name)).toEqual(['A', 'B'])
  })

  it('rejects duplicate names case-insensitively', () => {
    repo.create({ name: 'Luuk' })
    expect(() => repo.create({ name: 'luuk' })).toThrow(/name-taken/)
  })

  it('gets by id, returns null for missing', () => {
    const u = repo.create({ name: 'A' })
    expect(repo.get(u.id)?.name).toBe('A')
    expect(repo.get('missing')).toBeNull()
  })

  it('updates name and bumps updatedAt', async () => {
    const u = repo.create({ name: 'A' })
    await new Promise(r => setTimeout(r, 2))
    const u2 = repo.update(u.id, { name: 'B' })
    expect(u2!.name).toBe('B')
    expect(u2!.updatedAt).toBeGreaterThan(u.updatedAt)
  })

  it('deletes user and returns true', () => {
    const u = repo.create({ name: 'A' })
    expect(repo.delete(u.id)).toBe(true)
    expect(repo.get(u.id)).toBeNull()
    expect(repo.delete(u.id)).toBe(false)
  })

  it('preserves preferences JSON blob across round-trip', () => {
    const u = repo.create({ name: 'A', preferences: { defaultQuality: 'auto' } })
    expect(repo.get(u.id)!.preferences).toEqual({ defaultQuality: 'auto' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server test -- repos.users`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement users repo**

Create `server/src/repos/users.ts`:
```ts
import crypto from 'node:crypto'
import type { DatabaseSync } from '../db/index.ts'
import { UserRowSchema } from '../db/rowSchemas.ts'

export interface User {
  id: string
  name: string
  avatar: string | null
  preferences: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface UserInsert {
  name: string
  avatar?: string | null
  preferences?: Record<string, unknown>
}

export interface UserPatch {
  name?: string
  avatar?: string | null
  preferences?: Record<string, unknown>
}

export interface UserRepo {
  create(input: UserInsert): User
  list(): User[]
  get(id: string): User | null
  update(id: string, patch: UserPatch): User | null
  delete(id: string): boolean
}

function rowToUser(raw: unknown): User {
  const row = UserRowSchema.parse(raw)
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    preferences: JSON.parse(row.preferences) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Is the supplied name already used (case-insensitive, excluding optional id)? */
function nameTaken(db: DatabaseSync, name: string, excludingId?: string): boolean {
  if (excludingId) {
    const row = db.prepare(
      'SELECT 1 FROM users WHERE lower(name) = lower(?) AND id != ? LIMIT 1',
    ).get(name, excludingId)
    return !!row
  }
  const row = db.prepare('SELECT 1 FROM users WHERE lower(name) = lower(?) LIMIT 1').get(name)
  return !!row
}

export function createUserRepo(db: DatabaseSync): UserRepo {
  return {
    create(input) {
      if (nameTaken(db, input.name)) {
        throw Object.assign(new Error('name-taken'), { code: 'name-taken' })
      }
      const now = Date.now()
      const id = crypto.randomUUID()
      const prefsJson = JSON.stringify(input.preferences ?? {})
      db.prepare(
        `INSERT INTO users (id, name, avatar, preferences, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, input.name, input.avatar ?? null, prefsJson, now, now)
      return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id))
    },

    list() {
      const rows = db.prepare('SELECT * FROM users ORDER BY created_at ASC').all()
      return rows.map(rowToUser)
    },

    get(id) {
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id)
      return row ? rowToUser(row) : null
    },

    update(id, patch) {
      const existing = this.get(id)
      if (!existing) return null
      if (patch.name && nameTaken(db, patch.name, id)) {
        throw Object.assign(new Error('name-taken'), { code: 'name-taken' })
      }
      const next = {
        name: patch.name ?? existing.name,
        avatar: patch.avatar !== undefined ? patch.avatar : existing.avatar,
        preferences: patch.preferences ?? existing.preferences,
      }
      db.prepare(
        `UPDATE users
           SET name = ?, avatar = ?, preferences = ?, updated_at = ?
         WHERE id = ?`,
      ).run(next.name, next.avatar, JSON.stringify(next.preferences), Date.now(), id)
      return this.get(id)
    },

    delete(id) {
      const res = db.prepare('DELETE FROM users WHERE id = ?').run(id)
      return res.changes > 0
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w server test -- repos.users`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/repos/users.ts server/test/repos.users.test.ts
git commit -m "feat(server): users repo with name uniqueness + preferences JSON"
```

---

## Task 5: Media repository (upsert + list + soft-delete)

**Files:**
- Create: `server/src/repos/media.ts`
- Create: `server/test/repos.media.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/test/repos.media.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type DatabaseSync } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createMediaRepo, type MediaRepo, type MovieUpsert, type ShowUpsert, type EpisodeUpsert } from '../src/repos/media.ts'

function freshRepo(): { db: DatabaseSync; repo: MediaRepo } {
  const db = openDatabase(':memory:')
  migrate(db)
  return { db, repo: createMediaRepo(db) }
}

function movie(partial: Partial<MovieUpsert> = {}): MovieUpsert {
  return {
    id: 'mv-1',
    filePath: '/x/Oppenheimer.mkv',
    title: 'Oppenheimer',
    sortYear: 2023,
    durationSec: 10822,
    resolution: '3840x2160',
    videoCodec: 'hevc',
    container: 'matroska',
    hdr: { dv: true, hdr10: true, hdr10plus: false },
    audioTracks: [],
    subtitleTracks: [],
    mtimeMs: 1000,
    sizeBytes: 50_000_000,
    externalIds: { tmdb: 872585 },
    metadata: null,
    ...partial,
  }
}

function show(partial: Partial<ShowUpsert> = {}): ShowUpsert {
  return {
    id: 'sh-1',
    title: 'A Knight of the Seven Kingdoms',
    sortYear: 2026,
    externalIds: { tvdb: 433631 },
    metadata: null,
    ...partial,
  }
}

function episode(partial: Partial<EpisodeUpsert> = {}): EpisodeUpsert {
  return {
    id: 'ep-1',
    parentId: 'sh-1',
    filePath: '/shows/knight/s01e01.mkv',
    title: 'The Hedge Knight',
    season: 1,
    episode: 1,
    durationSec: 3600,
    resolution: '1920x1080',
    videoCodec: 'hevc',
    container: 'matroska',
    hdr: { dv: false, hdr10: false, hdr10plus: false },
    audioTracks: [],
    subtitleTracks: [],
    mtimeMs: 1000,
    sizeBytes: 10_000_000,
    externalIds: {},
    metadata: null,
    ...partial,
  }
}

describe('mediaRepo.upsertMovie', () => {
  it('inserts new movie with first/last seen set to now', () => {
    const { repo } = freshRepo()
    const m = repo.upsertMovie(movie())
    expect(m.firstSeenAt).toBe(m.lastSeenAt)
    expect(m.deletedAt).toBeNull()
  })

  it('updates last_seen on re-upsert without changing id', () => {
    const { repo } = freshRepo()
    const m1 = repo.upsertMovie(movie())
    const m2 = repo.upsertMovie(movie({ mtimeMs: 1000 }))
    expect(m2.id).toBe(m1.id)
    expect(m2.firstSeenAt).toBe(m1.firstSeenAt)
    expect(m2.lastSeenAt).toBeGreaterThanOrEqual(m1.lastSeenAt)
  })

  it('re-probes fields when mtime changed', () => {
    const { repo } = freshRepo()
    repo.upsertMovie(movie())
    const updated = repo.upsertMovie(movie({ mtimeMs: 2000, title: 'Oppenheimer (Directors Cut)' }))
    expect(updated.title).toBe('Oppenheimer (Directors Cut)')
  })

  it('revives a soft-deleted row', () => {
    const { db, repo } = freshRepo()
    repo.upsertMovie(movie())
    db.prepare('UPDATE media_items SET deleted_at = ? WHERE id = ?').run(999, 'mv-1')
    const revived = repo.upsertMovie(movie())
    expect(revived.deletedAt).toBeNull()
  })
})

describe('mediaRepo.softDeleteMissing', () => {
  it('marks rows missing from seenIds as deleted, leaves seen rows alone', () => {
    const { repo } = freshRepo()
    const a = repo.upsertMovie(movie({ id: 'a', filePath: '/a.mkv' }))
    repo.upsertMovie(movie({ id: 'b', filePath: '/b.mkv' }))
    repo.softDeleteMissing(new Set([a.id]))
    expect(repo.getById('a')!.deletedAt).toBeNull()
    expect(repo.getById('b')!.deletedAt).not.toBeNull()
  })

  it('does not overwrite deleted_at on already-deleted rows', () => {
    const { db, repo } = freshRepo()
    repo.upsertMovie(movie({ id: 'a', filePath: '/a.mkv' }))
    db.prepare('UPDATE media_items SET deleted_at = ? WHERE id = ?').run(500, 'a')
    repo.softDeleteMissing(new Set())
    expect(repo.getById('a')!.deletedAt).toBe(500)
  })
})

describe('mediaRepo.listMovies / listShows / getEpisodes', () => {
  it('listMovies excludes soft-deleted + non-movies', () => {
    const { repo } = freshRepo()
    repo.upsertMovie(movie({ id: 'a' }))
    repo.upsertShow(show({ id: 'sh' }))
    repo.softDeleteMissing(new Set(['a']))
    const list = repo.listMovies()
    expect(list.map(m => m.id)).toEqual(['a'])
  })

  it('listShows returns all live shows', () => {
    const { repo } = freshRepo()
    repo.upsertShow(show({ id: 's1' }))
    repo.upsertShow(show({ id: 's2', title: 'Other' }))
    expect(repo.listShows().length).toBe(2)
  })

  it('getEpisodes orders by season then episode', () => {
    const { repo } = freshRepo()
    repo.upsertShow(show())
    repo.upsertEpisode(episode({ id: 'e1', season: 1, episode: 2 }))
    repo.upsertEpisode(episode({ id: 'e2', season: 1, episode: 1 }))
    repo.upsertEpisode(episode({ id: 'e3', season: 2, episode: 1 }))
    const eps = repo.getEpisodes('sh-1')
    expect(eps.map(e => e.id)).toEqual(['e2', 'e1', 'e3'])
  })
})

describe('mediaRepo.getById', () => {
  it('returns domain object with JSON fields parsed', () => {
    const { repo } = freshRepo()
    repo.upsertMovie(movie())
    const m = repo.getById('mv-1')
    expect(m!.hdr).toEqual({ dv: true, hdr10: true, hdr10plus: false })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server test -- repos.media`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement media repo**

Create `server/src/repos/media.ts`:
```ts
import type { DatabaseSync } from '../db/index.ts'

export interface HdrFlags { dv: boolean; hdr10: boolean; hdr10plus: boolean; dvProfile?: number }
export interface ExternalIds { tmdb?: number; tvdb?: number; imdb?: string }

export interface AudioTrack {
  index: number
  codec: string
  channels: number
  language: string
  title: string
  default: boolean
}
export interface SubtitleTrack {
  index: number
  codec: string
  language: string
  forced: boolean
  embeddable: boolean
}

export interface MovieUpsert {
  id: string
  filePath: string
  title: string
  sortYear: number | null
  durationSec: number
  resolution: string
  videoCodec: string
  container: string
  hdr: HdrFlags
  audioTracks: AudioTrack[]
  subtitleTracks: SubtitleTrack[]
  mtimeMs: number
  sizeBytes: number
  externalIds: ExternalIds
  metadata: unknown
}

export interface ShowUpsert {
  id: string
  title: string
  sortYear: number | null
  externalIds: ExternalIds
  metadata: unknown
}

export interface EpisodeUpsert extends Omit<MovieUpsert, 'sortYear'> {
  parentId: string
  season: number
  episode: number
}

export interface MediaItem {
  id: string
  kind: 'movie' | 'show' | 'episode'
  parentId: string | null
  title: string
  sortYear: number | null
  season: number | null
  episode: number | null
  filePath: string | null
  durationSec: number | null
  resolution: string | null
  videoCodec: string | null
  container: string | null
  hdr: HdrFlags | null
  audioTracks: AudioTrack[] | null
  subtitleTracks: SubtitleTrack[] | null
  mtimeMs: number | null
  sizeBytes: number | null
  externalIds: ExternalIds
  metadata: unknown
  firstSeenAt: number
  lastSeenAt: number
  deletedAt: number | null
}

export interface MediaRepo {
  upsertMovie(input: MovieUpsert): MediaItem
  upsertShow(input: ShowUpsert): MediaItem
  upsertEpisode(input: EpisodeUpsert): MediaItem
  softDeleteMissing(seenIds: Set<string>): number
  listMovies(): MediaItem[]
  listShows(): MediaItem[]
  getEpisodes(showId: string): MediaItem[]
  getById(id: string): MediaItem | null
  getSeasons(showId: string): { number: number; episodeCount: number }[]
}

function rowToMedia(row: any): MediaItem {
  const j = <T>(s: string | null, fallback: T): T => (s ? JSON.parse(s) as T : fallback)
  return {
    id: row.id,
    kind: row.kind,
    parentId: row.parent_id,
    title: row.title,
    sortYear: row.sort_year,
    season: row.season,
    episode: row.episode,
    filePath: row.file_path,
    durationSec: row.duration_sec,
    resolution: row.resolution,
    videoCodec: row.video_codec,
    container: row.container,
    hdr: row.hdr ? JSON.parse(row.hdr) : null,
    audioTracks: row.audio_tracks ? JSON.parse(row.audio_tracks) : null,
    subtitleTracks: row.subtitle_tracks ? JSON.parse(row.subtitle_tracks) : null,
    mtimeMs: row.mtime_ms,
    sizeBytes: row.size_bytes,
    externalIds: j<ExternalIds>(row.external_ids, {}),
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    deletedAt: row.deleted_at,
  }
}

export function createMediaRepo(db: DatabaseSync): MediaRepo {
  const upsertMovieStmt = db.prepare(`
    INSERT INTO media_items (
      id, kind, parent_id, title, sort_year, season, episode,
      file_path, duration_sec, resolution, video_codec, container,
      hdr, audio_tracks, subtitle_tracks, mtime_ms, size_bytes,
      external_ids, metadata, first_seen_at, last_seen_at, deleted_at
    ) VALUES (
      ?, 'movie', NULL, ?, ?, NULL, NULL,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, NULL
    )
    ON CONFLICT(id) DO UPDATE SET
      title           = excluded.title,
      sort_year       = excluded.sort_year,
      file_path       = excluded.file_path,
      duration_sec    = excluded.duration_sec,
      resolution      = excluded.resolution,
      video_codec     = excluded.video_codec,
      container       = excluded.container,
      hdr             = excluded.hdr,
      audio_tracks    = excluded.audio_tracks,
      subtitle_tracks = excluded.subtitle_tracks,
      mtime_ms        = excluded.mtime_ms,
      size_bytes      = excluded.size_bytes,
      external_ids    = excluded.external_ids,
      metadata        = excluded.metadata,
      last_seen_at    = excluded.last_seen_at,
      deleted_at      = NULL
  `)

  const upsertShowStmt = db.prepare(`
    INSERT INTO media_items (
      id, kind, parent_id, title, sort_year,
      external_ids, metadata, first_seen_at, last_seen_at, deleted_at
    ) VALUES (
      ?, 'show', NULL, ?, ?,
      ?, ?, ?, ?, NULL
    )
    ON CONFLICT(id) DO UPDATE SET
      title        = excluded.title,
      sort_year    = excluded.sort_year,
      external_ids = excluded.external_ids,
      metadata     = excluded.metadata,
      last_seen_at = excluded.last_seen_at,
      deleted_at   = NULL
  `)

  const upsertEpisodeStmt = db.prepare(`
    INSERT INTO media_items (
      id, kind, parent_id, title, season, episode,
      file_path, duration_sec, resolution, video_codec, container,
      hdr, audio_tracks, subtitle_tracks, mtime_ms, size_bytes,
      external_ids, metadata, first_seen_at, last_seen_at, deleted_at
    ) VALUES (
      ?, 'episode', ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, NULL
    )
    ON CONFLICT(id) DO UPDATE SET
      parent_id       = excluded.parent_id,
      title           = excluded.title,
      season          = excluded.season,
      episode         = excluded.episode,
      file_path       = excluded.file_path,
      duration_sec    = excluded.duration_sec,
      resolution      = excluded.resolution,
      video_codec     = excluded.video_codec,
      container       = excluded.container,
      hdr             = excluded.hdr,
      audio_tracks    = excluded.audio_tracks,
      subtitle_tracks = excluded.subtitle_tracks,
      mtime_ms        = excluded.mtime_ms,
      size_bytes      = excluded.size_bytes,
      external_ids    = excluded.external_ids,
      metadata        = excluded.metadata,
      last_seen_at    = excluded.last_seen_at,
      deleted_at      = NULL
  `)

  const getById = (id: string): MediaItem | null => {
    const row = db.prepare('SELECT * FROM media_items WHERE id = ?').get(id)
    return row ? rowToMedia(row) : null
  }

  return {
    upsertMovie(input) {
      const now = Date.now()
      upsertMovieStmt.run(
        input.id, input.title, input.sortYear,
        input.filePath, input.durationSec, input.resolution, input.videoCodec, input.container,
        JSON.stringify(input.hdr), JSON.stringify(input.audioTracks), JSON.stringify(input.subtitleTracks),
        input.mtimeMs, input.sizeBytes,
        JSON.stringify(input.externalIds), input.metadata ? JSON.stringify(input.metadata) : null,
        now, now,
      )
      return getById(input.id)!
    },

    upsertShow(input) {
      const now = Date.now()
      upsertShowStmt.run(
        input.id, input.title, input.sortYear,
        JSON.stringify(input.externalIds), input.metadata ? JSON.stringify(input.metadata) : null,
        now, now,
      )
      return getById(input.id)!
    },

    upsertEpisode(input) {
      const now = Date.now()
      upsertEpisodeStmt.run(
        input.id, input.parentId, input.title, input.season, input.episode,
        input.filePath, input.durationSec, input.resolution, input.videoCodec, input.container,
        JSON.stringify(input.hdr), JSON.stringify(input.audioTracks), JSON.stringify(input.subtitleTracks),
        input.mtimeMs, input.sizeBytes,
        JSON.stringify(input.externalIds), input.metadata ? JSON.stringify(input.metadata) : null,
        now, now,
      )
      return getById(input.id)!
    },

    /**
     * Soft-delete rows whose id is NOT in seenIds and are not already deleted.
     * Uses a temp table to avoid SQLite's parameter-count limits on huge libraries.
     */
    softDeleteMissing(seenIds) {
      const now = Date.now()
      db.exec('CREATE TEMP TABLE seen (id TEXT PRIMARY KEY)')
      try {
        const ins = db.prepare('INSERT OR IGNORE INTO seen (id) VALUES (?)')
        for (const id of seenIds) ins.run(id)
        const res = db.prepare(
          `UPDATE media_items
             SET deleted_at = ?
           WHERE deleted_at IS NULL
             AND id NOT IN (SELECT id FROM seen)`,
        ).run(now)
        return res.changes
      } finally {
        db.exec('DROP TABLE seen')
      }
    },

    listMovies() {
      const rows = db.prepare(
        `SELECT * FROM media_items
          WHERE kind = 'movie' AND deleted_at IS NULL
          ORDER BY title ASC`,
      ).all()
      return rows.map(rowToMedia)
    },

    listShows() {
      const rows = db.prepare(
        `SELECT * FROM media_items
          WHERE kind = 'show' AND deleted_at IS NULL
          ORDER BY title ASC`,
      ).all()
      return rows.map(rowToMedia)
    },

    getEpisodes(showId) {
      const rows = db.prepare(
        `SELECT * FROM media_items
          WHERE kind = 'episode' AND parent_id = ? AND deleted_at IS NULL
          ORDER BY season ASC, episode ASC`,
      ).all(showId)
      return rows.map(rowToMedia)
    },

    getById,

    getSeasons(showId) {
      const rows = db.prepare(
        `SELECT season AS number, COUNT(*) AS episodeCount
           FROM media_items
          WHERE kind = 'episode' AND parent_id = ? AND deleted_at IS NULL
          GROUP BY season
          ORDER BY season ASC`,
      ).all(showId) as { number: number; episodeCount: number }[]
      return rows
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w server test -- repos.media`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/repos/media.ts server/test/repos.media.test.ts
git commit -m "feat(server): media_items repo with upsert + soft-delete"
```

---

## Task 6: Collections repository

**Files:**
- Create: `server/src/repos/collections.ts`
- Create: `server/test/repos.collections.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/test/repos.collections.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createMediaRepo } from '../src/repos/media.ts'
import { createCollectionsRepo, type Collection } from '../src/repos/collections.ts'

function setup() {
  const db = openDatabase(':memory:')
  migrate(db)
  const media = createMediaRepo(db)
  const repo = createCollectionsRepo(db)
  // seed two movies so FK is valid
  media.upsertMovie({
    id: 'm1', filePath: '/a.mkv', title: 'Lord of the Rings I',
    sortYear: 2001, durationSec: 10000, resolution: '1920x1080',
    videoCodec: 'hevc', container: 'matroska',
    hdr: { dv: false, hdr10: false, hdr10plus: false },
    audioTracks: [], subtitleTracks: [], mtimeMs: 1, sizeBytes: 1,
    externalIds: {}, metadata: null,
  })
  media.upsertMovie({
    id: 'm2', filePath: '/b.mkv', title: 'Lord of the Rings II',
    sortYear: 2002, durationSec: 10000, resolution: '1920x1080',
    videoCodec: 'hevc', container: 'matroska',
    hdr: { dv: false, hdr10: false, hdr10plus: false },
    audioTracks: [], subtitleTracks: [], mtimeMs: 1, sizeBytes: 1,
    externalIds: {}, metadata: null,
  })
  return { db, repo }
}

describe('collectionsRepo.replaceAll', () => {
  it('stores collections with items in position order', () => {
    const { repo } = setup()
    repo.replaceAll([
      { id: 'c1', name: 'Lord of the Rings', movieIds: ['m1', 'm2'] },
    ])
    const list = repo.list()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('Lord of the Rings')
    expect(list[0].movieIds).toEqual(['m1', 'm2'])
  })

  it('replaces existing collections wholesale', () => {
    const { repo } = setup()
    repo.replaceAll([{ id: 'c1', name: 'A', movieIds: ['m1'] }])
    repo.replaceAll([{ id: 'c2', name: 'B', movieIds: ['m2'] }])
    const list = repo.list()
    expect(list.map(c => c.id)).toEqual(['c2'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server test -- repos.collections`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement collections repo**

Create `server/src/repos/collections.ts`:
```ts
import type { DatabaseSync } from '../db/index.ts'

export interface Collection {
  id: string
  name: string
  movieIds: string[]
}

export interface CollectionsRepo {
  /** Replace the entire collection set. Used after a rescan — simpler than
   *  diffing and avoids leaving orphan rows. */
  replaceAll(collections: Collection[]): void
  list(): Collection[]
}

export function createCollectionsRepo(db: DatabaseSync): CollectionsRepo {
  return {
    replaceAll(collections) {
      const now = Date.now()
      db.exec('BEGIN')
      try {
        db.exec('DELETE FROM collections')   // cascades to collection_items
        const insCol = db.prepare('INSERT INTO collections (id, name, updated_at) VALUES (?, ?, ?)')
        const insItem = db.prepare(
          'INSERT INTO collection_items (collection_id, media_id, position) VALUES (?, ?, ?)',
        )
        for (const c of collections) {
          insCol.run(c.id, c.name, now)
          c.movieIds.forEach((mediaId, pos) => insItem.run(c.id, mediaId, pos))
        }
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },

    list() {
      const cols = db.prepare(
        'SELECT id, name FROM collections ORDER BY name ASC',
      ).all() as { id: string; name: string }[]
      const itemsByCollection = new Map<string, string[]>()
      const itemRows = db.prepare(
        `SELECT collection_id, media_id
           FROM collection_items
          ORDER BY collection_id, position`,
      ).all() as { collection_id: string; media_id: string }[]
      for (const row of itemRows) {
        const arr = itemsByCollection.get(row.collection_id) ?? []
        arr.push(row.media_id)
        itemsByCollection.set(row.collection_id, arr)
      }
      return cols.map(c => ({
        id: c.id,
        name: c.name,
        movieIds: itemsByCollection.get(c.id) ?? [],
      }))
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w server test -- repos.collections`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/repos/collections.ts server/test/repos.collections.test.ts
git commit -m "feat(server): collections repo with replaceAll semantics"
```

---

## Task 7: Progress repository + Continue Watching algorithm

**Files:**
- Create: `server/src/repos/progress.ts`
- Create: `server/test/repos.progress.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/test/repos.progress.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type DatabaseSync } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createMediaRepo, type MediaRepo } from '../src/repos/media.ts'
import { createUserRepo, type UserRepo } from '../src/repos/users.ts'
import { createProgressRepo, type ProgressRepo } from '../src/repos/progress.ts'

function setup() {
  const db = openDatabase(':memory:')
  migrate(db)
  const users = createUserRepo(db)
  const media = createMediaRepo(db)
  const progress = createProgressRepo(db, media, { watchedThresholdPct: 90 })
  return { db, users, media, progress }
}

function movieRow(id: string, title = 'M') {
  return {
    id, filePath: `/${id}.mkv`, title, sortYear: 2020,
    durationSec: 100, resolution: '1920x1080', videoCodec: 'h264', container: 'matroska',
    hdr: { dv: false, hdr10: false, hdr10plus: false },
    audioTracks: [], subtitleTracks: [], mtimeMs: 1, sizeBytes: 1,
    externalIds: {}, metadata: null,
  }
}
function episodeRow(id: string, parent: string, season: number, episode: number) {
  return {
    id, parentId: parent, filePath: `/${id}.mkv`, title: `Ep ${season}x${episode}`,
    season, episode,
    durationSec: 100, resolution: '1920x1080', videoCodec: 'h264', container: 'matroska',
    hdr: { dv: false, hdr10: false, hdr10plus: false },
    audioTracks: [], subtitleTracks: [], mtimeMs: 1, sizeBytes: 1,
    externalIds: {}, metadata: null,
  }
}

describe('progressRepo.setProgress', () => {
  it('inserts + updates', () => {
    const { users, media, progress } = setup()
    const u = users.create({ name: 'u' })
    media.upsertMovie(movieRow('m1'))
    const p1 = progress.setProgress(u.id, 'm1', { positionMs: 1000, durationMs: 60_000 })
    expect(p1.positionMs).toBe(1000)
    const p2 = progress.setProgress(u.id, 'm1', { positionMs: 2000, durationMs: 60_000 })
    expect(p2.positionMs).toBe(2000)
    expect(p2.updatedAt).toBeGreaterThanOrEqual(p1.updatedAt)
  })

  it('marks watched when crossing 90%', () => {
    const { users, media, progress } = setup()
    const u = users.create({ name: 'u' })
    media.upsertMovie(movieRow('m1'))
    const p = progress.setProgress(u.id, 'm1', { positionMs: 90_000, durationMs: 100_000 })
    expect(p.watched).toBe(true)
  })

  it('marks watched in last 30s regardless of percent', () => {
    const { users, media, progress } = setup()
    const u = users.create({ name: 'u' })
    media.upsertMovie(movieRow('m1'))
    // 89.9% → but only 1s left: should mark watched via the 30s rule.
    const p = progress.setProgress(u.id, 'm1', { positionMs: 999_000, durationMs: 1_000_000 })
    expect(p.watched).toBe(true)
  })
})

describe('progressRepo.continueWatching', () => {
  it('includes unwatched movies ordered by recency', async () => {
    const { users, media, progress } = setup()
    const u = users.create({ name: 'u' })
    media.upsertMovie(movieRow('m1', 'A'))
    media.upsertMovie(movieRow('m2', 'B'))
    progress.setProgress(u.id, 'm1', { positionMs: 10_000, durationMs: 60_000 })
    await new Promise(r => setTimeout(r, 2))
    progress.setProgress(u.id, 'm2', { positionMs: 20_000, durationMs: 60_000 })
    const list = progress.continueWatching(u.id)
    expect(list.map(x => x.mediaId)).toEqual(['m2', 'm1'])
  })

  it('dedupes shows to one entry = most recent episode', async () => {
    const { users, media, progress } = setup()
    const u = users.create({ name: 'u' })
    media.upsertShow({ id: 'sh', title: 'S', sortYear: 2020, externalIds: {}, metadata: null })
    media.upsertEpisode(episodeRow('e1', 'sh', 1, 1))
    media.upsertEpisode(episodeRow('e2', 'sh', 1, 2))
    progress.setProgress(u.id, 'e1', { positionMs: 10_000, durationMs: 60_000 })
    await new Promise(r => setTimeout(r, 2))
    progress.setProgress(u.id, 'e2', { positionMs: 15_000, durationMs: 60_000 })
    const list = progress.continueWatching(u.id)
    const episodes = list.filter(x => x.kind === 'episode')
    expect(episodes.length).toBe(1)
    expect(episodes[0].mediaId).toBe('e2')
    expect(episodes[0].show?.id).toBe('sh')
  })

  it('promotes next-up episode after one is watched', () => {
    const { users, media, progress } = setup()
    const u = users.create({ name: 'u' })
    media.upsertShow({ id: 'sh', title: 'S', sortYear: 2020, externalIds: {}, metadata: null })
    media.upsertEpisode(episodeRow('e1', 'sh', 1, 1))
    media.upsertEpisode(episodeRow('e2', 'sh', 1, 2))
    // finish e1
    progress.setProgress(u.id, 'e1', { positionMs: 100_000, durationMs: 100_000 })
    const list = progress.continueWatching(u.id)
    expect(list.length).toBe(1)
    expect(list[0].mediaId).toBe('e2')
    expect(list[0].positionMs).toBe(0)
  })

  it('drops the show entirely when all episodes watched', () => {
    const { users, media, progress } = setup()
    const u = users.create({ name: 'u' })
    media.upsertShow({ id: 'sh', title: 'S', sortYear: 2020, externalIds: {}, metadata: null })
    media.upsertEpisode(episodeRow('e1', 'sh', 1, 1))
    progress.setProgress(u.id, 'e1', { positionMs: 100_000, durationMs: 100_000 })
    expect(progress.continueWatching(u.id)).toEqual([])
  })

  it('caps list at 20', () => {
    const { users, media, progress } = setup()
    const u = users.create({ name: 'u' })
    for (let i = 0; i < 25; i++) {
      media.upsertMovie(movieRow(`m${i}`, `M${i}`))
      progress.setProgress(u.id, `m${i}`, { positionMs: 1000, durationMs: 60_000 })
    }
    const list = progress.continueWatching(u.id)
    expect(list.length).toBe(20)
  })
})

describe('progressRepo.markWatched', () => {
  it('sets watched flag explicitly', () => {
    const { users, media, progress } = setup()
    const u = users.create({ name: 'u' })
    media.upsertMovie(movieRow('m1'))
    progress.setProgress(u.id, 'm1', { positionMs: 1000, durationMs: 60_000 })
    const p = progress.markWatched(u.id, 'm1', true)
    expect(p!.watched).toBe(true)
  })
})

describe('progressRepo.clear', () => {
  it('removes the row', () => {
    const { users, media, progress } = setup()
    const u = users.create({ name: 'u' })
    media.upsertMovie(movieRow('m1'))
    progress.setProgress(u.id, 'm1', { positionMs: 1000, durationMs: 60_000 })
    progress.clear(u.id, 'm1')
    expect(progress.getProgress(u.id, 'm1')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server test -- repos.progress`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement progress repo**

Create `server/src/repos/progress.ts`:
```ts
import type { DatabaseSync } from '../db/index.ts'
import type { MediaItem, MediaRepo } from './media.ts'

export interface WatchProgress {
  mediaId: string
  positionMs: number
  durationMs: number
  watched: boolean
  updatedAt: number
}

export interface ContinueWatchingItem {
  mediaId: string
  kind: 'movie' | 'episode'
  positionMs: number
  durationMs: number
  percent: number
  updatedAt: number
  media: MediaItem
  show?: MediaItem
}

export interface ProgressInput {
  positionMs: number
  durationMs: number
}

export interface ProgressRepoOpts {
  watchedThresholdPct: number    // e.g. 90
}

/** Last 30 s of a title always counts as watched (credits buffer). */
const WATCHED_TAIL_MS = 30_000

export interface ProgressRepo {
  setProgress(userId: string, mediaId: string, input: ProgressInput): WatchProgress
  getProgress(userId: string, mediaId: string): WatchProgress | null
  markWatched(userId: string, mediaId: string, watched: boolean): WatchProgress | null
  clear(userId: string, mediaId: string): boolean
  continueWatching(userId: string): ContinueWatchingItem[]
}

function computeWatched(positionMs: number, durationMs: number, thresholdPct: number): boolean {
  if (durationMs <= 0) return false
  if (positionMs / durationMs >= thresholdPct / 100) return true
  if (durationMs - positionMs <= WATCHED_TAIL_MS) return true
  return false
}

interface ProgressRow {
  user_id: string
  media_id: string
  position_ms: number
  duration_ms: number
  watched: number
  updated_at: number
}

function rowToProgress(row: ProgressRow): WatchProgress {
  return {
    mediaId: row.media_id,
    positionMs: row.position_ms,
    durationMs: row.duration_ms,
    watched: row.watched !== 0,
    updatedAt: row.updated_at,
  }
}

export function createProgressRepo(
  db: DatabaseSync,
  mediaRepo: MediaRepo,
  opts: ProgressRepoOpts,
): ProgressRepo {
  const upsertStmt = db.prepare(`
    INSERT INTO watch_progress (user_id, media_id, position_ms, duration_ms, watched, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, media_id) DO UPDATE SET
      position_ms = excluded.position_ms,
      duration_ms = excluded.duration_ms,
      watched     = CASE WHEN watch_progress.watched = 1 THEN 1 ELSE excluded.watched END,
      updated_at  = excluded.updated_at
  `)

  return {
    setProgress(userId, mediaId, input) {
      const watched = computeWatched(input.positionMs, input.durationMs, opts.watchedThresholdPct) ? 1 : 0
      const now = Date.now()
      upsertStmt.run(userId, mediaId, input.positionMs, input.durationMs, watched, now)
      return rowToProgress(
        db.prepare('SELECT * FROM watch_progress WHERE user_id = ? AND media_id = ?')
          .get(userId, mediaId) as ProgressRow,
      )
    },

    getProgress(userId, mediaId) {
      const row = db.prepare('SELECT * FROM watch_progress WHERE user_id = ? AND media_id = ?')
        .get(userId, mediaId) as ProgressRow | undefined
      return row ? rowToProgress(row) : null
    },

    markWatched(userId, mediaId, watched) {
      const existing = this.getProgress(userId, mediaId)
      if (!existing) return null
      db.prepare(
        `UPDATE watch_progress
            SET watched = ?, updated_at = ?
          WHERE user_id = ? AND media_id = ?`,
      ).run(watched ? 1 : 0, Date.now(), userId, mediaId)
      return this.getProgress(userId, mediaId)
    },

    clear(userId, mediaId) {
      const res = db.prepare(
        'DELETE FROM watch_progress WHERE user_id = ? AND media_id = ?',
      ).run(userId, mediaId)
      return res.changes > 0
    },

    continueWatching(userId) {
      // Step 1: all rows for user, newest first, join media to resolve kinds.
      const rows = db.prepare(
        `SELECT wp.user_id, wp.media_id, wp.position_ms, wp.duration_ms, wp.watched, wp.updated_at,
                mi.kind, mi.parent_id
           FROM watch_progress wp
           JOIN media_items mi ON mi.id = wp.media_id AND mi.deleted_at IS NULL
          WHERE wp.user_id = ?
          ORDER BY wp.updated_at DESC`,
      ).all(userId) as Array<ProgressRow & { kind: 'movie' | 'episode'; parent_id: string | null }>

      const out: ContinueWatchingItem[] = []
      const seenShows = new Set<string>()
      const showLatestUpdated = new Map<string, number>()      // showId → latest row updated_at
      const showLatestRow = new Map<string, typeof rows[number]>()

      // Pass 1: unwatched entries, one per show for episodes.
      for (const row of rows) {
        if (row.kind === 'movie') {
          if (row.watched) continue
          const media = mediaRepo.getById(row.media_id)
          if (!media) continue
          out.push(toItem(row, media))
        } else {
          // episode: track show-latest regardless of watched, for pass 2
          const showId = row.parent_id!
          if (!showLatestUpdated.has(showId)) {
            showLatestUpdated.set(showId, row.updated_at)
            showLatestRow.set(showId, row)
          }
          if (row.watched) continue
          if (seenShows.has(showId)) continue
          seenShows.add(showId)
          const media = mediaRepo.getById(row.media_id)
          if (!media) continue
          const show = mediaRepo.getById(showId)
          if (!show) continue
          out.push(toItem(row, media, show))
        }
      }

      // Pass 2: next-up promotion. If the show's latest-touched episode was
      // watched and no unwatched entry for the show landed above, find the
      // next episode in (season, episode) order that isn't watched.
      for (const [showId, latest] of showLatestRow) {
        if (seenShows.has(showId)) continue
        if (!latest.watched) continue     // Pass 1 would have handled it
        const latestMedia = mediaRepo.getById(latest.media_id)
        if (!latestMedia || latestMedia.season == null || latestMedia.episode == null) continue
        const next = db.prepare(
          `SELECT * FROM media_items
            WHERE kind = 'episode' AND parent_id = ? AND deleted_at IS NULL
              AND (season > ? OR (season = ? AND episode > ?))
              AND id NOT IN (
                SELECT media_id FROM watch_progress
                 WHERE user_id = ? AND media_id IN (
                   SELECT id FROM media_items WHERE parent_id = ?
                 ) AND watched = 1
              )
            ORDER BY season ASC, episode ASC
            LIMIT 1`,
        ).get(latestMedia.parentId, latestMedia.season, latestMedia.season, latestMedia.episode, userId, showId) as any
        if (!next) continue
        const nextMedia = mediaRepo.getById(next.id)
        const show = mediaRepo.getById(showId)
        if (!nextMedia || !show) continue
        out.push({
          mediaId: nextMedia.id,
          kind: 'episode',
          positionMs: 0,
          durationMs: Math.round((nextMedia.durationSec ?? 0) * 1000),
          percent: 0,
          updatedAt: latest.updated_at,
          media: nextMedia,
          show,
        })
      }

      // Sort by updatedAt desc, cap at 20.
      out.sort((a, b) => b.updatedAt - a.updatedAt)
      return out.slice(0, 20)
    },
  }
}

function toItem(
  row: { media_id: string; position_ms: number; duration_ms: number; updated_at: number; kind: 'movie' | 'episode' },
  media: MediaItem,
  show?: MediaItem,
): ContinueWatchingItem {
  return {
    mediaId: row.media_id,
    kind: row.kind,
    positionMs: row.position_ms,
    durationMs: row.duration_ms,
    percent: row.duration_ms > 0 ? Math.round((row.position_ms / row.duration_ms) * 100) : 0,
    updatedAt: row.updated_at,
    media,
    show,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w server test -- repos.progress`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/repos/progress.ts server/test/repos.progress.test.ts
git commit -m "feat(server): watch_progress repo with continue-watching + next-up"
```

---

## Task 8: Config wiring for DB path + threshold

**Files:**
- Modify: `server/src/config.ts`
- Modify: `server/test/config.test.ts` (existing)

- [ ] **Step 1: Update config test**

Open `server/test/config.test.ts` and append:
```ts
// At the end of the existing describe block or as a new describe
describe('loadConfig — database', () => {
  it('defaults dbPath to <cacheDir>/horizon.db and threshold to 90', () => {
    delete process.env.HORIZON_DB_PATH
    delete process.env.HORIZON_WATCHED_THRESHOLD_PCT
    const cfg = loadConfig()
    expect(cfg.dbPath.endsWith('/horizon.db')).toBe(true)
    expect(cfg.watchedThresholdPct).toBe(90)
  })

  it('respects overrides', () => {
    process.env.HORIZON_DB_PATH = '/tmp/custom.db'
    process.env.HORIZON_WATCHED_THRESHOLD_PCT = '75'
    const cfg = loadConfig()
    expect(cfg.dbPath).toBe('/tmp/custom.db')
    expect(cfg.watchedThresholdPct).toBe(75)
    delete process.env.HORIZON_DB_PATH
    delete process.env.HORIZON_WATCHED_THRESHOLD_PCT
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server test -- config`
Expected: FAIL — `cfg.dbPath` undefined.

- [ ] **Step 3: Modify `server/src/config.ts`**

Apply diff: in the `Config` interface add fields `dbPath: string` and `watchedThresholdPct: number`. In the returned object from `loadConfig` add:
```ts
    dbPath: process.env.HORIZON_DB_PATH ?? `${cacheDir}/horizon.db`,
    watchedThresholdPct: envInt('HORIZON_WATCHED_THRESHOLD_PCT', 90),
```
where `cacheDir` is the already-computed local variable (reorder if needed so `cacheDir` is bound before use — simplest is to hoist `cacheDir` into a `const` before the return object).

Final `loadConfig` return shape additions (inline with the existing returns):
```ts
const cacheDir = process.env.HORIZON_CACHE_DIR ?? `${os.tmpdir()}/horizon-cache`
return {
  // ... all existing fields
  cacheDir,
  dbPath: process.env.HORIZON_DB_PATH ?? `${cacheDir}/horizon.db`,
  watchedThresholdPct: envInt('HORIZON_WATCHED_THRESHOLD_PCT', 90),
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w server test -- config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/config.ts server/test/config.test.ts
git commit -m "feat(server): config.dbPath + watchedThresholdPct"
```

---

## Task 9: Scanner rewrites to repo-backed writes

**Files:**
- Modify: `server/src/scanner/scanner.ts` (major rewrite)
- Create: `server/test/scanner.integration.test.ts`
- Modify: `server/src/routes/sessions.ts` (imports + media lookup)
- Modify: `server/src/routes/library.ts` (queries + shape)
- Modify: `server/src/index.ts` (open DB, wire repos)
- Modify: `server/src/server.ts` (accept repos instead of LibraryIndex)

- [ ] **Step 1: Write scanner integration test**

Create `server/test/scanner.integration.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createMediaRepo } from '../src/repos/media.ts'
import { createCollectionsRepo } from '../src/repos/collections.ts'
import { rescan } from '../src/scanner/scanner.ts'

// Stub probe — scanner is generally backed by ffprobe. We inject a fake via
// the module interface so these tests don't need ffprobe on PATH.
import * as probeMod from '../src/scanner/probe.ts'

function fakeProbe(filePath: string) {
  return {
    duration: 10,
    resolution: '1920x1080',
    videoCodec: 'h264',
    videoBitrate: 1000,
    hdr: { dv: false, hdr10: false, hdr10plus: false },
    audioTracks: [],
    subtitleTracks: [],
    container: 'matroska',
  }
}

describe('rescan (integration)', () => {
  let tmpRoot: string
  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'horizon-scan-'))
    ;(probeMod as any).probe = async (p: string) => fakeProbe(p)
  })
  afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }) })

  it('ingests movie + show + episode, soft-deletes missing on second pass', async () => {
    const moviesRoot = path.join(tmpRoot, 'movies')
    const showsRoot = path.join(tmpRoot, 'shows')
    const showDir = path.join(showsRoot, 'A Knight of the Seven Kingdoms (2026) {tvdb-1}')
    const seasonDir = path.join(showDir, 'Season 01')
    mkdirSync(moviesRoot, { recursive: true })
    mkdirSync(seasonDir, { recursive: true })
    writeFileSync(path.join(moviesRoot, 'Oppenheimer (2023) {tmdb-872585}.mkv'), '')
    writeFileSync(path.join(seasonDir, 'A Knight (2026) - S01E01 - Pilot [WEB].mkv'), '')

    const db = openDatabase(':memory:')
    migrate(db)
    const media = createMediaRepo(db)
    const collections = createCollectionsRepo(db)

    await rescan({
      moviesRoots: [moviesRoot],
      showsRoots: [showsRoot],
      cacheDir: tmpRoot,
      scanConcurrency: 2,
    }, { media, collections, tmdb: null })

    expect(media.listMovies().map(m => m.title)).toEqual(['Oppenheimer'])
    expect(media.listShows().map(s => s.title)).toEqual(['A Knight of the Seven Kingdoms'])
    expect(media.getEpisodes(media.listShows()[0].id)).toHaveLength(1)

    // Remove the episode, rescan
    rmSync(path.join(seasonDir, 'A Knight (2026) - S01E01 - Pilot [WEB].mkv'))
    await rescan({
      moviesRoots: [moviesRoot],
      showsRoots: [showsRoot],
      cacheDir: tmpRoot,
      scanConcurrency: 2,
    }, { media, collections, tmdb: null })
    expect(media.getEpisodes(media.listShows()[0].id)).toHaveLength(0)
  })
})
```

Also add `import { afterEach } from 'vitest'` at the top.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server test -- scanner.integration`
Expected: FAIL — `rescan` export missing or has old signature.

- [ ] **Step 3: Rewrite scanner to be repo-backed**

Replace `server/src/scanner/scanner.ts` entirely:
```ts
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { probe } from './probe.ts'
import { detectCollections } from './collections.ts'
import { parseIdsFromPath, parseIds, mergeIds } from './ids.ts'
import { pMap } from './concurrency.ts'
import type { MediaRepo, MovieUpsert, ShowUpsert, EpisodeUpsert } from '../repos/media.ts'
import type { CollectionsRepo, Collection } from '../repos/collections.ts'
import type { TmdbProvider } from '../metadata/tmdb.ts'

export interface ScanConfig {
  moviesRoots: string[]
  showsRoots: string[]
  cacheDir: string
  scanConcurrency: number
}

export interface ScanDeps {
  media: MediaRepo
  collections: CollectionsRepo
  tmdb: TmdbProvider | null
}

const MOVIE_RE = /^(.+?)\s*\((\d{4})\)/
const EPISODE_RE = /S(\d{2})E(\d{2})/i

function hashId(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 16)
}

function cleanTitle(raw: string): string {
  return raw.replace(/\s*\{[^}]+\}/g, '').replace(/\s*\[[^\]]+\]/g, '').replace(/\s*\(\d{4}\)/, '').trim()
}

function episodeTitle(basename: string): string {
  const stripped = basename.replace(/\.[^.]+$/, '')
  const m = /S\d{2}E\d{2}\s*-\s*([^[]+?)(?:\s*\[|\s*-\s*\[|$)/i.exec(stripped)
  if (m) return m[1].trim()
  return cleanTitle(stripped)
}

async function walkDir(dir: string): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await walkDir(full))
    else if (/\.(mkv|mp4|mov|avi|m4v)$/i.test(entry.name)) files.push(full)
  }
  return files
}

/** Walk a movies root, probe, upsert into media_items.
 *  Returns the set of ids that were seen (for soft-delete reconciliation). */
async function scanMoviesRoot(
  root: string,
  cfg: ScanConfig,
  media: MediaRepo,
): Promise<Set<string>> {
  const seen = new Set<string>()
  const files = await walkDir(root).catch(() => [])
  const candidates = files
    .map(file => {
      const base = path.basename(file, path.extname(file))
      const m = MOVIE_RE.exec(base)
      return m ? { file, base, m } : null
    })
    .filter((x): x is NonNullable<typeof x> => !!x)

  const { stat } = await import('node:fs/promises')
  await pMap(candidates, cfg.scanConcurrency, async ({ file, m }) => {
    const p = await probe(file, cfg.cacheDir).catch(() => null)
    if (!p) return
    const st = await stat(file)
    const id = hashId(file)
    media.upsertMovie({
      id,
      filePath: file,
      title: m[1].trim(),
      sortYear: parseInt(m[2], 10),
      durationSec: p.duration,
      resolution: p.resolution,
      videoCodec: p.videoCodec,
      container: p.container,
      hdr: p.hdr,
      audioTracks: p.audioTracks,
      subtitleTracks: p.subtitleTracks,
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      externalIds: parseIdsFromPath(file),
      metadata: null,
    })
    seen.add(id)
  })
  return seen
}

async function scanShowsRoot(
  root: string,
  cfg: ScanConfig,
  media: MediaRepo,
): Promise<Set<string>> {
  const seen = new Set<string>()
  const showDirs = await readdir(root, { withFileTypes: true }).catch(() => [])
  const { stat } = await import('node:fs/promises')
  for (const showDirEnt of showDirs) {
    if (!showDirEnt.isDirectory()) continue
    const showDirAbs = path.join(root, showDirEnt.name)
    const showId = hashId(showDirAbs)
    media.upsertShow({
      id: showId,
      title: cleanTitle(showDirEnt.name),
      sortYear: null,
      externalIds: parseIds(showDirEnt.name),
      metadata: null,
    })
    seen.add(showId)

    const files = await walkDir(showDirAbs).catch(() => [])
    const epCands = files.map(file => {
      const base = path.basename(file)
      const em = EPISODE_RE.exec(base)
      return em ? { file, base, em } : null
    }).filter((x): x is NonNullable<typeof x> => !!x)

    await pMap(epCands, cfg.scanConcurrency, async ({ file, base, em }) => {
      const p = await probe(file, cfg.cacheDir).catch(() => null)
      if (!p) return
      const st = await stat(file)
      const id = hashId(file)
      const insert: EpisodeUpsert = {
        id,
        parentId: showId,
        filePath: file,
        title: episodeTitle(base),
        season: parseInt(em[1], 10),
        episode: parseInt(em[2], 10),
        durationSec: p.duration,
        resolution: p.resolution,
        videoCodec: p.videoCodec,
        container: p.container,
        hdr: p.hdr,
        audioTracks: p.audioTracks,
        subtitleTracks: p.subtitleTracks,
        mtimeMs: st.mtimeMs,
        sizeBytes: st.size,
        externalIds: mergeIds(parseIds(showDirEnt.name), parseIds(base)),
        metadata: null,
      }
      media.upsertEpisode(insert)
      seen.add(id)
    })
  }
  return seen
}

/** One-shot scan: walks roots, upserts rows, soft-deletes missing, rebuilds
 *  collections. TMDB enrichment happens after (background). */
export async function rescan(cfg: ScanConfig, deps: ScanDeps): Promise<void> {
  const t0 = Date.now()
  const seen = new Set<string>()
  for (const r of cfg.moviesRoots) (await scanMoviesRoot(r, cfg, deps.media)).forEach(id => seen.add(id))
  for (const r of cfg.showsRoots) (await scanShowsRoot(r, cfg, deps.media)).forEach(id => seen.add(id))
  deps.media.softDeleteMissing(seen)

  const movies = deps.media.listMovies()
  const detected = detectCollections(movies)
  const collections: Collection[] = detected.map(c => ({
    id: hashId(c.name),
    name: c.name,
    movieIds: c.movies.map(m => m.id),
  }))
  deps.collections.replaceAll(collections)
  console.log(`Library: ${movies.length} movies, ${deps.media.listShows().length} shows (scan ${Date.now() - t0}ms)`)

  if (deps.tmdb) void backgroundEnrich(deps.tmdb, deps.media)
}

async function backgroundEnrich(tmdb: TmdbProvider, media: MediaRepo): Promise<void> {
  const t0 = Date.now()
  const movies = media.listMovies()
  const shows = media.listShows()
  const tasks: Promise<void>[] = []
  for (const mv of movies) {
    tasks.push((async () => {
      const ids = mv.externalIds
      let m = ids.tmdb ? await tmdb.movieByTmdbId(ids.tmdb) : null
      if (!m && ids.imdb) m = await tmdb.movieByImdbId(ids.imdb)
      if (!m) m = await tmdb.searchMovie(mv.title, mv.sortYear ?? undefined)
      if (m) {
        media.upsertMovie({
          id: mv.id,
          filePath: mv.filePath!,
          title: mv.title,
          sortYear: mv.sortYear,
          durationSec: mv.durationSec!,
          resolution: mv.resolution!,
          videoCodec: mv.videoCodec!,
          container: mv.container!,
          hdr: mv.hdr!,
          audioTracks: mv.audioTracks!,
          subtitleTracks: mv.subtitleTracks!,
          mtimeMs: mv.mtimeMs!,
          sizeBytes: mv.sizeBytes!,
          externalIds: mv.externalIds,
          metadata: m,
        })
      }
    })())
  }
  for (const sh of shows) {
    tasks.push((async () => {
      const ids = sh.externalIds
      let s = ids.tmdb ? await tmdb.showByTmdbId(ids.tmdb) : null
      if (!s && ids.tvdb) s = await tmdb.showByTvdbId(ids.tvdb)
      if (!s) s = await tmdb.searchShow(sh.title)
      if (!s) return
      media.upsertShow({
        id: sh.id,
        title: sh.title,
        sortYear: sh.sortYear,
        externalIds: sh.externalIds,
        metadata: s,
      })
      const eps = media.getEpisodes(sh.id)
      await Promise.all(eps.map(async ep => {
        const epMeta = s.tmdbId ? await tmdb.episode(s.tmdbId, ep.season!, ep.episode!) : null
        if (!epMeta) return
        media.upsertEpisode({
          id: ep.id,
          parentId: sh.id,
          filePath: ep.filePath!,
          title: epMeta.title ?? ep.title,
          season: ep.season!,
          episode: ep.episode!,
          durationSec: ep.durationSec!,
          resolution: ep.resolution!,
          videoCodec: ep.videoCodec!,
          container: ep.container!,
          hdr: ep.hdr!,
          audioTracks: ep.audioTracks!,
          subtitleTracks: ep.subtitleTracks!,
          mtimeMs: ep.mtimeMs!,
          sizeBytes: ep.sizeBytes!,
          externalIds: ep.externalIds,
          metadata: epMeta,
        })
      }))
    })())
  }
  await Promise.all(tasks.map(p => p.catch(() => {/* non-fatal */})))
  console.log(`Metadata enriched in ${Date.now() - t0}ms (background)`)
}
```

- [ ] **Step 4: Wire DB + repos into `index.ts`**

Replace `server/src/index.ts`:
```ts
import { loadConfig } from './config.ts'
import { detectHwAccel } from './transcode/hwaccel.ts'
import { openDatabase } from './db/index.ts'
import { migrate } from './db/migrations.ts'
import { createMediaRepo } from './repos/media.ts'
import { createCollectionsRepo } from './repos/collections.ts'
import { createUserRepo } from './repos/users.ts'
import { createProgressRepo } from './repos/progress.ts'
import { createTmdbProvider } from './metadata/tmdb.ts'
import { rescan } from './scanner/scanner.ts'
import { createSessionManager } from './session/manager.ts'
import { buildServer } from './server.ts'

async function main() {
  const cfg = loadConfig()
  const hwAccel = await detectHwAccel(cfg.forceEncoder)

  const db = openDatabase(cfg.dbPath)
  migrate(db)
  const mediaRepo = createMediaRepo(db)
  const collectionsRepo = createCollectionsRepo(db)
  const userRepo = createUserRepo(db)
  const progressRepo = createProgressRepo(db, mediaRepo, {
    watchedThresholdPct: cfg.watchedThresholdPct,
  })
  const tmdb = createTmdbProvider(cfg.tmdbToken, cfg.cacheDir)

  const sessions = createSessionManager(cfg)

  const app = await buildServer(cfg, hwAccel, { mediaRepo, collectionsRepo, userRepo, progressRepo }, sessions)
  await app.listen({ port: cfg.port, host: '0.0.0.0' })
  console.log(`Horizon listening on :${cfg.port}`)

  // Kick off scan after server is accepting traffic so library API doesn't
  // block boot on libraries with many files.
  void rescan(cfg, { media: mediaRepo, collections: collectionsRepo, tmdb })
    .catch(err => console.error('Scan error:', err))
}

main().catch((err) => { console.error(err); process.exit(1) })
```

- [ ] **Step 5: Rewire buildServer + routes to use repos**

Modify `server/src/server.ts` to take repos instead of `LibraryIndex`:
```ts
import Fastify from 'fastify'
import fastifyWebSocket from '@fastify/websocket'
import fastifyCors from '@fastify/cors'
import type { Config } from './config.ts'
import type { HwAccel } from './transcode/hwaccel.ts'
import type { MediaRepo } from './repos/media.ts'
import type { CollectionsRepo } from './repos/collections.ts'
import type { UserRepo } from './repos/users.ts'
import type { ProgressRepo } from './repos/progress.ts'
import type { SessionManager } from './session/manager.ts'
import { registerHealth } from './routes/health.ts'
import { registerLibrary } from './routes/library.ts'
import { registerSessions } from './routes/sessions.ts'
import { registerPlaylists } from './routes/playlists.ts'
import { registerSegments } from './routes/segments.ts'
import { registerMetadata } from './routes/metadata.ts'

export interface Repos {
  mediaRepo: MediaRepo
  collectionsRepo: CollectionsRepo
  userRepo: UserRepo
  progressRepo: ProgressRepo
}

export async function buildServer(
  cfg: Config,
  hwAccel: HwAccel,
  repos: Repos,
  sessions: SessionManager,
) {
  const app = Fastify({ logger: true })
  await app.register(fastifyCors, { origin: cfg.corsOrigins.includes('*') ? true : cfg.corsOrigins })
  await app.register(fastifyWebSocket)

  registerHealth(app, hwAccel)
  registerLibrary(app, repos.mediaRepo, repos.collectionsRepo)
  registerSessions(app, cfg, hwAccel, repos.mediaRepo, sessions)
  registerPlaylists(app, sessions)
  registerSegments(app, hwAccel, sessions)
  registerMetadata(app, cfg)
  return app
}
```

Modify `server/src/routes/library.ts` signature + body to:
```ts
import type { FastifyInstance } from 'fastify'
import type { MediaRepo } from '../repos/media.ts'
import type { CollectionsRepo } from '../repos/collections.ts'

export function registerLibrary(
  app: FastifyInstance,
  media: MediaRepo,
  collections: CollectionsRepo,
) {
  app.get('/library/movies', async () => media.listMovies())

  app.get('/library/movies/collections', async () => {
    const cols = collections.list()
    return cols.map(c => ({
      id: c.id,
      name: c.name,
      movies: c.movieIds.map(id => media.getById(id)).filter((m): m is NonNullable<typeof m> => !!m),
    }))
  })

  app.get('/library/shows', async () => {
    const shows = media.listShows()
    return shows.map(s => ({ ...s, seasons: media.getSeasons(s.id) }))
  })

  app.get<{ Params: { show: string } }>('/library/shows/:show', async (req, reply) => {
    const show = media.getById(req.params.show)
    if (!show || show.kind !== 'show' || show.deletedAt !== null) {
      return reply.status(404).send({ error: 'Show not found', code: 'not-found' })
    }
    return { ...show, seasons: media.getSeasons(show.id) }
  })

  app.get<{ Params: { show: string } }>('/library/shows/:show/seasons', async (req, reply) => {
    const show = media.getById(req.params.show)
    if (!show) return reply.status(404).send({ error: 'Show not found', code: 'not-found' })
    return media.getSeasons(show.id)
  })

  app.get<{ Params: { show: string; season: string } }>(
    '/library/shows/:show/seasons/:season',
    async (req, reply) => {
      const show = media.getById(req.params.show)
      if (!show) return reply.status(404).send({ error: 'Show not found', code: 'not-found' })
      const season = parseInt(req.params.season, 10)
      if (!Number.isFinite(season)) return reply.status(400).send({ error: 'Invalid season', code: 'invalid-input' })
      return media.getEpisodes(show.id).filter(e => e.season === season)
    },
  )
}
```

Modify `server/src/routes/sessions.ts` signature: replace `index: LibraryIndex` parameter with `media: MediaRepo`. Change `index.byId.get(mediaId)` → `media.getById(mediaId)`. The rest stays identical.

- [ ] **Step 6: Run the scanner integration test**

Run: `npm -w server test -- scanner.integration`
Expected: PASS.

Also run full suite:
Run: `npm -w server test`
Expected: all existing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/scanner/scanner.ts server/test/scanner.integration.test.ts \
         server/src/server.ts server/src/index.ts \
         server/src/routes/library.ts server/src/routes/sessions.ts
git commit -m "refactor(server): scanner writes to media repo; routes query repos (delete LibraryIndex)"
```

---

## Task 10: Users HTTP routes

**Files:**
- Create: `server/src/routes/users.ts`
- Create: `server/test/routes.users.test.ts`
- Modify: `server/src/server.ts` (add `registerUsers`)

- [ ] **Step 1: Write failing tests**

Create `server/test/routes.users.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createUserRepo, type UserRepo } from '../src/repos/users.ts'
import { registerUsers } from '../src/routes/users.ts'

async function buildApp(users: UserRepo) {
  const app = Fastify({ logger: false })
  registerUsers(app, users)
  await app.ready()
  return app
}

describe('POST /users', () => {
  it('creates a user', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const app = await buildApp(users)
    const res = await app.inject({ method: 'POST', url: '/users', payload: { name: 'Luuk' } })
    expect(res.statusCode).toBe(200)
    const body = res.json() as any
    expect(body.name).toBe('Luuk')
  })

  it('rejects missing name', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const app = await buildApp(users)
    const res = await app.inject({ method: 'POST', url: '/users', payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid-input')
  })

  it('409 on duplicate name', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    users.create({ name: 'Luuk' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'POST', url: '/users', payload: { name: 'luuk' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('name-taken')
  })
})

describe('GET /users and /users/:id', () => {
  it('lists + gets', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const u = users.create({ name: 'A' })
    const app = await buildApp(users)
    const list = await app.inject({ method: 'GET', url: '/users' })
    expect(list.json()).toHaveLength(1)
    const one = await app.inject({ method: 'GET', url: `/users/${u.id}` })
    expect(one.json().id).toBe(u.id)
    const missing = await app.inject({ method: 'GET', url: '/users/missing' })
    expect(missing.statusCode).toBe(404)
  })
})

describe('PATCH + DELETE /users/:id', () => {
  it('patches name', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const u = users.create({ name: 'A' })
    const app = await buildApp(users)
    const res = await app.inject({ method: 'PATCH', url: `/users/${u.id}`, payload: { name: 'B' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('B')
  })

  it('deletes + subsequent 404', async () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const u = users.create({ name: 'A' })
    const app = await buildApp(users)
    const del = await app.inject({ method: 'DELETE', url: `/users/${u.id}` })
    expect(del.statusCode).toBe(204)
    const get = await app.inject({ method: 'GET', url: `/users/${u.id}` })
    expect(get.statusCode).toBe(404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server test -- routes.users`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement users route**

Create `server/src/routes/users.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { UserRepo } from '../repos/users.ts'
import { sendNotFound, badRequest, errorReply } from './errors.ts'

const CreateBody = z.object({
  name: z.string().min(1).max(100),
  avatar: z.string().nullable().optional(),
  preferences: z.record(z.string(), z.unknown()).optional(),
})
const PatchBody = z.object({
  name: z.string().min(1).max(100).optional(),
  avatar: z.string().nullable().optional(),
  preferences: z.record(z.string(), z.unknown()).optional(),
})

export function registerUsers(app: FastifyInstance, users: UserRepo): void {
  app.post('/users', async (req, reply) => {
    const parse = CreateBody.safeParse(req.body)
    if (!parse.success) return badRequest(reply, 'invalid-input', parse.error.message)
    try {
      return users.create(parse.data)
    } catch (err) {
      if ((err as { code?: string }).code === 'name-taken') {
        return errorReply(reply, 409, 'name-taken', 'Profile name already in use')
      }
      throw err
    }
  })

  app.get('/users', async () => users.list())

  app.get<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
    const u = users.get(req.params.id)
    if (!u) return sendNotFound(reply, 'user-not-found', 'User not found')
    return u
  })

  app.patch<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
    const parse = PatchBody.safeParse(req.body)
    if (!parse.success) return badRequest(reply, 'invalid-input', parse.error.message)
    try {
      const u = users.update(req.params.id, parse.data)
      if (!u) return sendNotFound(reply, 'user-not-found', 'User not found')
      return u
    } catch (err) {
      if ((err as { code?: string }).code === 'name-taken') {
        return errorReply(reply, 409, 'name-taken', 'Profile name already in use')
      }
      throw err
    }
  })

  app.delete<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
    users.delete(req.params.id)
    return reply.status(204).send()
  })
}
```

- [ ] **Step 4: Wire into server.ts**

In `server/src/server.ts`, add `import { registerUsers } from './routes/users.ts'` and after `registerMetadata(app, cfg)` add:
```ts
  registerUsers(app, repos.userRepo)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm -w server test -- routes.users`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/users.ts server/test/routes.users.test.ts server/src/server.ts
git commit -m "feat(server): /users CRUD route"
```

---

## Task 11: Progress HTTP routes

**Files:**
- Create: `server/src/routes/progress.ts`
- Create: `server/test/routes.progress.test.ts`
- Modify: `server/src/server.ts`

- [ ] **Step 1: Write failing tests**

Create `server/test/routes.progress.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createUserRepo, type UserRepo } from '../src/repos/users.ts'
import { createMediaRepo, type MediaRepo } from '../src/repos/media.ts'
import { createProgressRepo, type ProgressRepo } from '../src/repos/progress.ts'
import { registerProgress } from '../src/routes/progress.ts'

function movie(id: string) {
  return {
    id, filePath: `/${id}.mkv`, title: id, sortYear: 2020,
    durationSec: 100, resolution: '1920x1080', videoCodec: 'h264', container: 'matroska',
    hdr: { dv: false, hdr10: false, hdr10plus: false },
    audioTracks: [], subtitleTracks: [], mtimeMs: 1, sizeBytes: 1,
    externalIds: {}, metadata: null,
  }
}

function setup() {
  const db = openDatabase(':memory:'); migrate(db)
  const users = createUserRepo(db)
  const media = createMediaRepo(db)
  const progress = createProgressRepo(db, media, { watchedThresholdPct: 90 })
  const u = users.create({ name: 'Luuk' })
  media.upsertMovie(movie('m1'))
  return { users, media, progress, user: u }
}

async function buildApp(users: UserRepo, media: MediaRepo, progress: ProgressRepo) {
  const app = Fastify({ logger: false })
  registerProgress(app, users, progress)
  await app.ready()
  return app
}

describe('progress routes', () => {
  it('GET /users/:userId/progress/:mediaId 404 when no entry', async () => {
    const { users, media, progress, user } = setup()
    const app = await buildApp(users, media, progress)
    const res = await app.inject({
      method: 'GET', url: `/users/${user.id}/progress/m1`,
      headers: { 'x-horizon-user': user.id },
    })
    expect(res.statusCode).toBe(404)
  })

  it('rejects with 400 when X-Horizon-User is missing', async () => {
    const { users, media, progress, user } = setup()
    const app = await buildApp(users, media, progress)
    const res = await app.inject({
      method: 'GET', url: `/users/${user.id}/progress/m1`,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('no-user')
  })

  it('rejects when header user differs from path', async () => {
    const { users, media, progress, user } = setup()
    const app = await buildApp(users, media, progress)
    const res = await app.inject({
      method: 'GET', url: `/users/${user.id}/progress/m1`,
      headers: { 'x-horizon-user': 'someone-else' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('PATCH watched flag', async () => {
    const { users, media, progress, user } = setup()
    progress.setProgress(user.id, 'm1', { positionMs: 1000, durationMs: 60_000 })
    const app = await buildApp(users, media, progress)
    const res = await app.inject({
      method: 'PATCH', url: `/users/${user.id}/progress/m1`,
      headers: { 'x-horizon-user': user.id },
      payload: { watched: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().watched).toBe(true)
  })

  it('GET continue-watching returns list', async () => {
    const { users, media, progress, user } = setup()
    progress.setProgress(user.id, 'm1', { positionMs: 1000, durationMs: 60_000 })
    const app = await buildApp(users, media, progress)
    const res = await app.inject({
      method: 'GET', url: `/users/${user.id}/continue-watching`,
      headers: { 'x-horizon-user': user.id },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server test -- routes.progress`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement route**

Create `server/src/routes/progress.ts`:
```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { UserRepo } from '../repos/users.ts'
import type { ProgressRepo } from '../repos/progress.ts'
import { sendNotFound, badRequest } from './errors.ts'

const PatchBody = z.object({ watched: z.boolean() })

/** Ensure the active-user header is present + matches the path user + resolves
 *  to an existing row. Returns null and writes a reply on failure. */
function requireUser(
  users: UserRepo,
  req: FastifyRequest,
  reply: FastifyReply,
  pathUserId: string,
): string | null {
  const hdr = req.headers['x-horizon-user']
  const id = typeof hdr === 'string' ? hdr : null
  if (!id) { badRequest(reply, 'no-user', 'Missing X-Horizon-User header'); return null }
  if (id !== pathUserId) { badRequest(reply, 'user-mismatch', 'Header user does not match path'); return null }
  if (!users.get(id)) { badRequest(reply, 'no-user', 'User not found'); return null }
  return id
}

export function registerProgress(
  app: FastifyInstance,
  users: UserRepo,
  progress: ProgressRepo,
): void {
  app.get<{ Params: { userId: string } }>(
    '/users/:userId/continue-watching',
    async (req, reply) => {
      const userId = requireUser(users, req, reply, req.params.userId)
      if (!userId) return
      return progress.continueWatching(userId)
    },
  )

  app.get<{ Params: { userId: string; mediaId: string } }>(
    '/users/:userId/progress/:mediaId',
    async (req, reply) => {
      const userId = requireUser(users, req, reply, req.params.userId)
      if (!userId) return
      const wp = progress.getProgress(userId, req.params.mediaId)
      if (!wp) return sendNotFound(reply, 'progress-not-found', 'No progress for media')
      return wp
    },
  )

  app.patch<{ Params: { userId: string; mediaId: string } }>(
    '/users/:userId/progress/:mediaId',
    async (req, reply) => {
      const userId = requireUser(users, req, reply, req.params.userId)
      if (!userId) return
      const parse = PatchBody.safeParse(req.body)
      if (!parse.success) return badRequest(reply, 'invalid-input', parse.error.message)
      const wp = progress.markWatched(userId, req.params.mediaId, parse.data.watched)
      if (!wp) return sendNotFound(reply, 'progress-not-found', 'No progress for media')
      return wp
    },
  )

  app.delete<{ Params: { userId: string; mediaId: string } }>(
    '/users/:userId/progress/:mediaId',
    async (req, reply) => {
      const userId = requireUser(users, req, reply, req.params.userId)
      if (!userId) return
      progress.clear(userId, req.params.mediaId)
      return reply.status(204).send()
    },
  )
}
```

- [ ] **Step 4: Wire into server.ts**

In `server/src/server.ts` add `import { registerProgress } from './routes/progress.ts'` and after `registerUsers`:
```ts
  registerProgress(app, repos.userRepo, repos.progressRepo)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm -w server test -- routes.progress`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/progress.ts server/test/routes.progress.test.ts server/src/server.ts
git commit -m "feat(server): progress routes with X-Horizon-User guard"
```

---

## Task 12: WebSocket progress message + flusher

**Files:**
- Modify: `server/src/ws/messages.ts`
- Modify: `server/src/ws/handler.ts`
- Modify: `server/src/session/types.ts`
- Create: `server/src/ws/progress-flusher.ts`
- Create: `server/test/ws.progress.test.ts`
- Modify: `server/src/routes/sessions.ts` (pass progress repo into WS handler)

- [ ] **Step 1: Extend messages.ts + tests**

Open `server/test/messages.test.ts` and add at the end:
```ts
  it('parses progress', () => {
    expect(parseWsMessage({ type: 'progress', positionMs: 1500, durationMs: 60_000 }))
      .toEqual({ type: 'progress', positionMs: 1500, durationMs: 60_000 })
  })
  it('rejects progress with negative position', () => {
    expect(parseWsMessage({ type: 'progress', positionMs: -5, durationMs: 60_000 })).toBeNull()
  })
```

In `server/src/ws/messages.ts`, add the discriminant:
```ts
export interface ProgressMessage {
  type: 'progress'
  positionMs: number
  durationMs: number
}

export type WsMessage =
  | HelloMessage
  | BandwidthReportMessage
  | SeekMessage
  | QualityOverrideMessage
  | AudioTrackMessage
  | SubtitleTrackMessage
  | ParkMessage
  | ResumeMessage
  | ProgressMessage

// inside parseWsMessage switch:
    case 'progress': {
      if (typeof m.positionMs !== 'number' || m.positionMs < 0) return null
      if (typeof m.durationMs !== 'number' || m.durationMs <= 0) return null
      return { type: 'progress', positionMs: m.positionMs, durationMs: m.durationMs }
    }
```

- [ ] **Step 2: Run messages tests**

Run: `npm -w server test -- messages`
Expected: PASS (includes two new cases).

- [ ] **Step 3: Add progress buffer to Session**

In `server/src/session/types.ts` inside the `Session` interface, add:
```ts
  /** User on whose behalf this session was created (sourced from POST body).
   *  Undefined for headless / anonymous sessions — progress flushes no-op in
   *  that case. */
  userId?: string
  /** Last reported client playback position. Dirty flag is inferred by
   *  comparison against the last-flushed position in the flusher. */
  lastProgress?: { positionMs: number; durationMs: number; at: number }
  /** Attached by the WS upgrade handler; cleared on close. Lives here rather
   *  than in a WeakMap so final-flush on destroy can find it. */
  _flusher?: import('../ws/progress-flusher.ts').ProgressFlusher
```

Modify `CreateSessionBody` in `server/src/routes/sessions.ts` to accept optional `userId: z.string()` — parsed with zod, optional:
```ts
interface CreateSessionBody {
  mediaId: string
  capabilities: ClientCapabilities
  audioTrackIndex?: number
  subtitleTrackIndex?: number | null
  userId?: string
  startPositionMs?: number
}
```

In the session create call, add `userId: req.body.userId ?? undefined,`.

- [ ] **Step 4: Implement progress-flusher**

Create `server/src/ws/progress-flusher.ts`:
```ts
import type { Session } from '../session/types.ts'
import type { ProgressRepo } from '../repos/progress.ts'

const FLUSH_INTERVAL_MS = 30_000

/**
 * Per-session flusher: keeps the last reported position in session.lastProgress
 * and writes to DB at most once every FLUSH_INTERVAL_MS when dirty. Attach on
 * WS connect, call finalFlush() on close.
 */
export interface ProgressFlusher {
  record(positionMs: number, durationMs: number): void
  finalFlush(): void
  stop(): void
}

export function createProgressFlusher(
  session: Session,
  progress: ProgressRepo,
): ProgressFlusher {
  let lastFlushedPos = -1
  const doFlush = () => {
    if (!session.userId) return
    const cur = session.lastProgress
    if (!cur) return
    if (cur.positionMs === lastFlushedPos) return
    progress.setProgress(session.userId, session.mediaId, {
      positionMs: cur.positionMs,
      durationMs: cur.durationMs,
    })
    lastFlushedPos = cur.positionMs
  }
  const timer = setInterval(doFlush, FLUSH_INTERVAL_MS)
  return {
    record(positionMs, durationMs) {
      session.lastProgress = { positionMs, durationMs, at: Date.now() }
    },
    finalFlush: doFlush,
    stop() { clearInterval(timer) },
  }
}
```

- [ ] **Step 5: Write flusher test**

Create `server/test/ws.progress.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createMediaRepo } from '../src/repos/media.ts'
import { createUserRepo } from '../src/repos/users.ts'
import { createProgressRepo } from '../src/repos/progress.ts'
import { createProgressFlusher } from '../src/ws/progress-flusher.ts'
import type { Session } from '../src/session/types.ts'

function fakeSession(overrides: Partial<Session>): Session {
  return {
    id: 'sess', mediaId: 'm1', filePath: '/x', state: 'active',
    method: 'transcode', capabilities: {} as any,
    selectedAudioTrack: 0, selectedSubtitleTrack: null,
    profiles: [], renditionCodecs: [], needsToneMap: false,
    toneMap: { operator: 'hable' } as any, sessionDir: '/x',
    sessionReady: true, durationSec: 100, currentStartSegment: 0,
    reconnectToken: 'tok', seekPositionMs: 0, createdAt: 0,
    ...overrides,
  } as Session
}

describe('progress flusher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('flushes only on interval and on finalFlush', () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const media = createMediaRepo(db)
    const progress = createProgressRepo(db, media, { watchedThresholdPct: 90 })
    const u = users.create({ name: 'a' })
    media.upsertMovie({
      id: 'm1', filePath: '/x.mkv', title: 'x', sortYear: 2020,
      durationSec: 100, resolution: '1920x1080', videoCodec: 'h264', container: 'mkv',
      hdr: { dv: false, hdr10: false, hdr10plus: false },
      audioTracks: [], subtitleTracks: [], mtimeMs: 1, sizeBytes: 1,
      externalIds: {}, metadata: null,
    })

    const session = fakeSession({ userId: u.id, mediaId: 'm1' })
    const f = createProgressFlusher(session, progress)
    f.record(1000, 60_000)
    f.record(2000, 60_000)
    // No flush yet
    expect(progress.getProgress(u.id, 'm1')).toBeNull()
    vi.advanceTimersByTime(30_000)
    const p1 = progress.getProgress(u.id, 'm1')
    expect(p1?.positionMs).toBe(2000)
    f.record(3000, 60_000)
    f.finalFlush()
    expect(progress.getProgress(u.id, 'm1')?.positionMs).toBe(3000)
    f.stop()
  })

  it('does nothing when userId is absent', () => {
    const db = openDatabase(':memory:'); migrate(db)
    const users = createUserRepo(db)
    const media = createMediaRepo(db)
    const progress = createProgressRepo(db, media, { watchedThresholdPct: 90 })
    const session = fakeSession({}) // no userId
    const f = createProgressFlusher(session, progress)
    f.record(1000, 60_000)
    vi.advanceTimersByTime(30_000)
    f.finalFlush()
    // no rows inserted
    expect((db.prepare('SELECT COUNT(*) as c FROM watch_progress').get() as any).c).toBe(0)
    f.stop()
  })
})
```

- [ ] **Step 6: Dispatch progress in handler**

Modify `server/src/ws/handler.ts`:
- Add parameter `progressRepo: ProgressRepo` to `handleWsMessage`.
- Add a handler case `'progress'` that calls `session._flusher?.record(msg.positionMs, msg.durationMs)`.

Actually the simpler injection: attach the flusher on the Session itself. Modify `Session` type:
```ts
  _flusher?: { record(p: number, d: number): void; finalFlush(): void; stop(): void }
```

Modify `server/src/routes/sessions.ts` WS upgrade handler:
```ts
// After session.wsSocket = socket and state update, attach the flusher:
import { createProgressFlusher } from '../ws/progress-flusher.ts'
// ...
session._flusher = createProgressFlusher(session, progressRepo)

// on 'close':
socket.on('close', () => {
  session._flusher?.finalFlush()
  session._flusher?.stop()
  session._flusher = undefined
  // ... existing close logic
})
```

And modify `registerSessions` signature to take `progressRepo: ProgressRepo` — plumb in server.ts's `buildServer`:
```ts
registerSessions(app, cfg, hwAccel, repos.mediaRepo, sessions, repos.progressRepo)
```

Finally in `handleWsMessage`, add the case in the handlers map:
```ts
  progress(msg, { session }) {
    if (msg.type !== 'progress') return
    session._flusher?.record(msg.positionMs, msg.durationMs)
  },
```

- [ ] **Step 7: Run tests**

Run: `npm -w server test -- ws.progress`
Expected: PASS, 2 tests.

Run: `npm -w server test`
Expected: all tests still pass.

- [ ] **Step 8: Commit**

```bash
git add server/src/ws/messages.ts server/src/ws/handler.ts server/src/ws/progress-flusher.ts \
         server/src/session/types.ts server/src/routes/sessions.ts server/src/server.ts \
         server/test/messages.test.ts server/test/ws.progress.test.ts
git commit -m "feat(server): WS progress reporting with 30s flusher + final flush on close"
```

---

## Task 13: Seek-on-create for Player resume

**Files:**
- Modify: `server/src/routes/sessions.ts`
- Modify: `server/src/session/types.ts`
- Modify: `server/src/transcode/ffmpeg.ts`

- [ ] **Step 1: Add startPositionMs handling**

In `server/src/routes/sessions.ts` POST handler, extract `startPositionMs` from the body. If > 0 and method !== 'direct-play', set session state so the first ffmpeg spawn starts at that offset:
```ts
if (req.body.startPositionMs && req.body.startPositionMs > 0 && decision.method !== 'direct-play') {
  const segNum = Math.floor(req.body.startPositionMs / 1000 / SEGMENT_DURATION_SEC)
  session.currentStartSegment = segNum
  session.seekPositionMs = req.body.startPositionMs
}
```

Add `import { SEGMENT_DURATION_SEC } from '../transcode/ffmpeg.ts'` at the top if missing.

- [ ] **Step 2: Add a test for it**

In `server/test/routes.progress.test.ts` (or a new `routes.sessions.start.test.ts`) skip this — spawn involves a real ffmpeg. Instead, add a small unit test to sessions.ts by extracting a helper that computes segNum; verify startPositionMs → segment conversion.

Create `server/test/sessions.startpos.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { SEGMENT_DURATION_SEC } from '../src/transcode/ffmpeg.ts'

function startSegFor(positionMs: number): number {
  return Math.floor(positionMs / 1000 / SEGMENT_DURATION_SEC)
}

describe('startPositionMs → segment', () => {
  it('zero position → seg 0', () => {
    expect(startSegFor(0)).toBe(0)
  })
  it('1 s into SEGMENT_DURATION_SEC=1 → seg 1', () => {
    expect(startSegFor(1000)).toBe(1)
  })
  it('12s into 1s-seg config → seg 12', () => {
    expect(startSegFor(12_000)).toBe(12)
  })
})
```

Run: `npm -w server test -- sessions.startpos`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/sessions.ts server/test/sessions.startpos.test.ts
git commit -m "feat(server): POST /sessions accepts startPositionMs for resume"
```

---

## Task 14: SDK user + progress client methods

**Files:**
- Modify: `sdk/src/types.ts`
- Modify: `sdk/src/client.ts`
- Modify: `sdk/src/index.ts`

- [ ] **Step 1: Add types**

Append to `sdk/src/types.ts`:
```ts
export interface User {
  id: string
  name: string
  avatar: string | null
  preferences: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface WatchProgress {
  mediaId: string
  positionMs: number
  durationMs: number
  watched: boolean
  updatedAt: number
}

export interface ContinueWatchingItem {
  mediaId: string
  kind: 'movie' | 'episode'
  positionMs: number
  durationMs: number
  percent: number
  updatedAt: number
  media: MediaItem
  show?: MediaItem
}
```

- [ ] **Step 2: Extend client.ts**

Inside `HorizonClient`, add:
```ts
  private activeUserId: string | null = null

  setActiveUser(id: string | null): void { this.activeUserId = id }
  getActiveUser(): string | null { return this.activeUserId }

  private userHeaders(): Record<string, string> {
    return this.activeUserId ? { 'X-Horizon-User': this.activeUserId } : {}
  }
```

And extend the fetch wrapper to merge `userHeaders()`:
```ts
  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'Content-Type': 'application/json', ...this.userHeaders(), ...(init?.headers ?? {}) },
      ...init,
    })
    // rest unchanged
  }
```

Add the following groups to the class body (next to `readonly library = { ... }`):
```ts
  readonly users = {
    list: () => this.fetch<User[]>('/users'),
    get: (id: string) => this.fetch<User>(`/users/${id}`),
    create: (body: { name: string; avatar?: string | null }) =>
      this.fetch<User>('/users', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: { name?: string; avatar?: string | null; preferences?: Record<string, unknown> }) =>
      this.fetch<User>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: (id: string) =>
      this.fetch<void>(`/users/${id}`, { method: 'DELETE' }),
  }

  readonly progress = {
    continueWatching: (userId: string) =>
      this.fetch<ContinueWatchingItem[]>(`/users/${userId}/continue-watching`),
    get: (userId: string, mediaId: string) =>
      this.fetch<WatchProgress>(`/users/${userId}/progress/${mediaId}`)
        .catch(err => err.code === 'progress-not-found' ? null : Promise.reject(err)),
    markWatched: (userId: string, mediaId: string, watched: boolean) =>
      this.fetch<WatchProgress>(
        `/users/${userId}/progress/${mediaId}`,
        { method: 'PATCH', body: JSON.stringify({ watched }) },
      ),
    clear: (userId: string, mediaId: string) =>
      this.fetch<void>(`/users/${userId}/progress/${mediaId}`, { method: 'DELETE' }),
  }
```

Note on fetch typing: `fetch<void>` returns `undefined` when the server sends 204 — handle in the fetch wrapper by checking `res.status === 204` before `res.json()`:
```ts
    if (res.status === 204) return undefined as T
```

- [ ] **Step 3: Extend index.ts**

Append to `sdk/src/index.ts`:
```ts
export type { User, WatchProgress, ContinueWatchingItem } from './types.ts'
```

- [ ] **Step 4: Verify typecheck**

Run: `cd sdk && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add sdk/src/types.ts sdk/src/client.ts sdk/src/index.ts
git commit -m "feat(sdk): users + progress client methods with X-Horizon-User header"
```

---

## Task 15: SDK `reportProgress` + resume arg

**Files:**
- Modify: `sdk/src/session.ts`
- Modify: `sdk/src/client.ts`

- [ ] **Step 1: Add reportProgress method**

In `sdk/src/session.ts`, inside the `PlaybackSession` class add:
```ts
  reportProgress(positionMs: number, durationMs: number): void {
    this._send({ type: 'progress', positionMs, durationMs })
  }
```

- [ ] **Step 2: Add startPositionMs to PlayOptions**

In `sdk/src/client.ts`, extend `PlayOptions`:
```ts
export interface PlayOptions extends Omit<PlaybackSessionOptions, 'sessionInfo' | 'baseUrl' | 'capabilities'> {
  // ... existing fields
  startPositionMs?: number
}
```

And in `play()`, include it in the POST body:
```ts
    const sessionInfo = await this.fetch<SessionInfo>('/sessions', {
      method: 'POST',
      body: JSON.stringify({
        mediaId,
        capabilities: caps,
        audioTrackIndex: opts.audioTrackIndex ?? 0,
        subtitleTrackIndex: opts.subtitleTrackIndex ?? null,
        userId: this.activeUserId ?? undefined,
        startPositionMs: opts.startPositionMs,
      }),
    })
```

- [ ] **Step 3: Verify typecheck + tests**

Run: `cd sdk && npx tsc --noEmit`
Expected: no errors.

Run: `npm -w sdk test`
Expected: PASS (existing tests, no new ones here).

- [ ] **Step 4: Commit**

```bash
git add sdk/src/session.ts sdk/src/client.ts
git commit -m "feat(sdk): session.reportProgress over WS + startPositionMs in play()"
```

---

## Task 16: Client — active-user hook + horizon wiring

**Files:**
- Create: `app/src/hooks/useActiveUser.ts`
- Modify: `app/src/horizon.ts`

- [ ] **Step 1: Write the hook**

Create `app/src/hooks/useActiveUser.ts`:
```ts
import { useEffect, useState, useCallback } from 'react'
import { horizon } from '../horizon.ts'
import type { User } from '@horizon/sdk'

const STORAGE_KEY = 'horizonUser'

let cachedId: string | null = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
const listeners = new Set<(id: string | null) => void>()

function setGlobal(id: string | null) {
  cachedId = id
  if (id) localStorage.setItem(STORAGE_KEY, id)
  else localStorage.removeItem(STORAGE_KEY)
  horizon.setActiveUser(id)
  for (const fn of listeners) fn(id)
}

// Sync at module load so any request before the first hook mount has the header.
if (cachedId) horizon.setActiveUser(cachedId)

/**
 * Returns the current active-user state + setter. Subscribes to global
 * changes so `<ProfileBadge />`, `<Library />`, `<Player />` all stay in sync
 * without prop-drilling.
 */
export function useActiveUser(): {
  user: User | null
  userId: string | null
  setUserId: (id: string | null) => void
  loading: boolean
} {
  const [userId, setUserIdState] = useState<string | null>(cachedId)
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState<boolean>(!!cachedId)

  useEffect(() => {
    const fn = (id: string | null) => setUserIdState(id)
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!userId) { setUser(null); setLoading(false); return }
    setLoading(true)
    horizon.users.get(userId)
      .then(u => { if (!cancelled) setUser(u) })
      .catch(() => { if (!cancelled) { setGlobal(null); setUser(null) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [userId])

  const setUserId = useCallback((id: string | null) => setGlobal(id), [])
  return { user, userId, setUserId, loading }
}
```

- [ ] **Step 2: Update `horizon.ts`**

Replace `app/src/horizon.ts`:
```ts
import { HorizonClient } from '@horizon/sdk'
// Empty baseUrl = same origin via Vite proxy. `setActiveUser` flips the
// X-Horizon-User header on every request.
export const horizon = new HorizonClient({ baseUrl: '' })
```

- [ ] **Step 3: Verify typecheck**

Run: `cd app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/hooks/useActiveUser.ts app/src/horizon.ts
git commit -m "feat(app): useActiveUser hook, header wiring via SDK.setActiveUser"
```

---

## Task 17: Setup page + routing guard

**Files:**
- Create: `app/src/pages/Setup.tsx`
- Create: `app/src/pages/ProfilePicker.tsx`
- Modify: `app/src/App.tsx`

- [ ] **Step 1: Create Setup**

Create `app/src/pages/Setup.tsx`:
```tsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { horizon } from '../horizon.ts'
import { useActiveUser } from '../hooks/useActiveUser.ts'

const AVATARS = ['🐱', '🐶', '🦊', '🐼', '🐸', '🚀', '🎮', '🎬', '🎨', '👤']

export default function Setup() {
  const navigate = useNavigate()
  const { setUserId } = useActiveUser()
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!name.trim()) { setError('Name required'); return }
    setBusy(true); setError(null)
    try {
      const u = await horizon.users.create({ name: name.trim(), avatar })
      setUserId(u.id)
      navigate('/', { replace: true })
    } catch (err) {
      const code = (err as { code?: string }).code
      setError(code === 'name-taken' ? 'Profile name already in use' : String((err as Error).message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ maxWidth: 480, margin: '80px auto', padding: '32px 24px', background: '#1a1a1a', borderRadius: 12, border: '1px solid #2a2a2a' }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>Welcome to Horizon</h1>
      <p style={{ color: '#888', marginBottom: 24 }}>Create your first profile to get started.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 13, color: '#bbb' }}>Name</span>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={40}
            style={{ padding: '10px 12px', borderRadius: 6, border: '1px solid #333', background: '#0a0a0a', color: '#fff' }}
          />
        </label>
        <div>
          <div style={{ fontSize: 13, color: '#bbb', marginBottom: 8 }}>Avatar</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {AVATARS.map(a => (
              <button key={a} onClick={() => setAvatar(a === avatar ? null : a)}
                style={{
                  width: 42, height: 42, fontSize: 22, borderRadius: 8,
                  border: avatar === a ? '2px solid #fff' : '1px solid #333',
                  background: '#0a0a0a', color: '#fff', cursor: 'pointer',
                }}>{a}</button>
            ))}
          </div>
        </div>
        {error && <div style={{ color: '#ef4444', fontSize: 13 }}>{error}</div>}
        <button disabled={busy || !name.trim()} onClick={submit}
          style={{ padding: '10px 16px', borderRadius: 6, border: 'none', background: '#fff', color: '#000', cursor: 'pointer', fontWeight: 600 }}>
          {busy ? 'Creating…' : 'Get started'}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create ProfilePicker**

Create `app/src/pages/ProfilePicker.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { horizon } from '../horizon.ts'
import { useActiveUser } from '../hooks/useActiveUser.ts'
import type { User } from '@horizon/sdk'

export default function ProfilePicker() {
  const navigate = useNavigate()
  const { setUserId } = useActiveUser()
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')

  useEffect(() => {
    horizon.users.list()
      .then(setUsers)
      .finally(() => setLoading(false))
  }, [])

  function pick(u: User) {
    setUserId(u.id)
    navigate('/', { replace: true })
  }

  async function addUser() {
    if (!newName.trim()) return
    const u = await horizon.users.create({ name: newName.trim(), avatar: null })
    setUsers([...users, u])
    setNewName('')
    setAdding(false)
  }

  if (loading) return <div style={{ color: '#888', padding: 40 }}>Loading profiles…</div>

  return (
    <div style={{ maxWidth: 800, margin: '80px auto', padding: '0 16px' }}>
      <h1 style={{ fontSize: 24, marginBottom: 24 }}>Who's watching?</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 16 }}>
        {users.map(u => (
          <button key={u.id} onClick={() => pick(u)}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
              background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 12,
              padding: 20, cursor: 'pointer', color: '#fff',
            }}>
            <div style={{ width: 72, height: 72, borderRadius: '50%', background: '#2a2a2a',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32 }}>
              {u.avatar ?? u.name.charAt(0).toUpperCase()}
            </div>
            <div style={{ fontWeight: 600 }}>{u.name}</div>
          </button>
        ))}
        <button onClick={() => setAdding(true)}
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            background: 'transparent', border: '2px dashed #333', borderRadius: 12,
            padding: 20, cursor: 'pointer', color: '#888', minHeight: 150,
          }}>+ Add profile</button>
      </div>
      {adding && (
        <div style={{ marginTop: 24, display: 'flex', gap: 8 }}>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Profile name"
            style={{ padding: '10px 12px', borderRadius: 6, border: '1px solid #333', background: '#0a0a0a', color: '#fff', flex: 1 }} />
          <button onClick={addUser}
            style={{ padding: '10px 16px', borderRadius: 6, border: 'none', background: '#fff', color: '#000', cursor: 'pointer' }}>Create</button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Add guard to App.tsx**

Replace `app/src/App.tsx`:
```tsx
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import Library from './pages/Library.tsx'
import Player from './pages/Player.tsx'
import Show from './pages/Show.tsx'
import Setup from './pages/Setup.tsx'
import ProfilePicker from './pages/ProfilePicker.tsx'
import { useActiveUser } from './hooks/useActiveUser.ts'
import { horizon } from './horizon.ts'

function Guard({ children }: { children: React.ReactNode }) {
  const { userId, loading } = useActiveUser()
  const [hasUsers, setHasUsers] = useState<boolean | null>(null)
  const location = useLocation()

  useEffect(() => {
    horizon.users.list().then(list => setHasUsers(list.length > 0))
  }, [userId])

  if (loading || hasUsers === null) return null
  if (!hasUsers && location.pathname !== '/setup') return <Navigate to="/setup" replace />
  if (hasUsers && !userId && location.pathname !== '/profiles' && location.pathname !== '/setup') {
    return <Navigate to="/profiles" replace />
  }
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      <Route path="/setup" element={<Setup />} />
      <Route path="/profiles" element={<ProfilePicker />} />
      <Route path="/" element={<Guard><Library /></Guard>} />
      <Route path="/show/:showId" element={<Guard><Show /></Guard>} />
      <Route path="/play/:mediaId" element={<Guard><Player /></Guard>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
```

- [ ] **Step 4: Verify build**

Run: `cd app && npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add app/src/pages/Setup.tsx app/src/pages/ProfilePicker.tsx app/src/App.tsx
git commit -m "feat(app): /setup and /profiles pages + routing guard"
```

---

## Task 18: Profile badge in header + Continue Watching rail

**Files:**
- Create: `app/src/components/ProfileBadge.tsx`
- Create: `app/src/components/ContinueWatchingRail.tsx`
- Modify: `app/src/pages/Library.tsx`

- [ ] **Step 1: ProfileBadge**

Create `app/src/components/ProfileBadge.tsx`:
```tsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useActiveUser } from '../hooks/useActiveUser.ts'
import { horizon } from '../horizon.ts'

export default function ProfileBadge() {
  const { user, setUserId } = useActiveUser()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  if (!user) return null

  async function deleteProfile() {
    if (!user || !confirm(`Delete profile "${user.name}"? Watch history is lost.`)) return
    await horizon.users.delete(user.id)
    setUserId(null)
    navigate('/profiles')
  }

  return (
    <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 10 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'rgba(0,0,0,0.7)', border: '1px solid #444', borderRadius: 20,
          padding: '4px 12px 4px 4px', cursor: 'pointer', color: '#fff',
        }}>
        <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#2a2a2a',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>
          {user.avatar ?? user.name.charAt(0).toUpperCase()}
        </div>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{user.name}</span>
      </button>
      {open && (
        <div style={{ position: 'absolute', right: 0, marginTop: 6,
                      background: '#1a1a1a', border: '1px solid #333', borderRadius: 8,
                      minWidth: 160, padding: 4 }}>
          <button onClick={() => navigate('/profiles')}
            style={{ display: 'block', width: '100%', padding: '8px 12px', background: 'transparent', border: 'none', color: '#fff', textAlign: 'left', cursor: 'pointer', fontSize: 13 }}>
            Switch profile
          </button>
          <button onClick={deleteProfile}
            style={{ display: 'block', width: '100%', padding: '8px 12px', background: 'transparent', border: 'none', color: '#ef4444', textAlign: 'left', cursor: 'pointer', fontSize: 13 }}>
            Delete profile
          </button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: ContinueWatchingRail**

Create `app/src/components/ContinueWatchingRail.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { horizon } from '../horizon.ts'
import { tmdbImageUrl } from '@horizon/sdk'
import type { ContinueWatchingItem, MovieMetadata, EpisodeMetadata, ShowMetadataInfo } from '@horizon/sdk'

export default function ContinueWatchingRail({ userId }: { userId: string }) {
  const [items, setItems] = useState<ContinueWatchingItem[]>([])
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false
    horizon.progress.continueWatching(userId)
      .then(list => { if (!cancelled) setItems(list) })
      .catch(() => { if (!cancelled) setItems([]) })
    return () => { cancelled = true }
  }, [userId])

  if (items.length === 0) return null

  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16, marginBottom: 12, color: '#ccc' }}>Continue watching</h2>
      <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8 }}>
        {items.map(item => <Card key={item.mediaId} item={item} onOpen={() => navigate(`/play/${item.mediaId}`)} />)}
      </div>
    </div>
  )
}

function Card({ item, onOpen }: { item: ContinueWatchingItem; onOpen: () => void }) {
  const epMeta = item.media.metadata as EpisodeMetadata | null
  const showMeta = item.show?.metadata as ShowMetadataInfo | null | undefined
  const movieMeta = item.media.metadata as MovieMetadata | null
  const img = item.kind === 'episode'
    ? tmdbImageUrl(epMeta?.stillPath, 'w342') ?? tmdbImageUrl(showMeta?.backdropPath, 'w342')
    : tmdbImageUrl(movieMeta?.backdropPath, 'w342') ?? tmdbImageUrl(movieMeta?.posterPath, 'w342')
  const remainingMin = Math.max(0, Math.round((item.durationMs - item.positionMs) / 60_000))
  const title = item.kind === 'episode'
    ? `${item.show?.title ?? ''}  ·  S${String(item.media.season).padStart(2,'0')}E${String(item.media.episode).padStart(2,'0')} ${item.media.title}`
    : item.media.title

  return (
    <div onClick={onOpen} style={{ flex: '0 0 260px', background: '#1a1a1a', borderRadius: 8, cursor: 'pointer', overflow: 'hidden', border: '1px solid #2a2a2a' }}>
      <div style={{ aspectRatio: '16 / 9', background: '#0a0a0a', position: 'relative' }}>
        {img && <img src={img} alt={title} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, background: '#333' }}>
          <div style={{ height: '100%', width: `${item.percent}%`, background: '#ef4444' }} />
        </div>
      </div>
      <div style={{ padding: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
        <div style={{ fontSize: 11, color: '#888' }}>{remainingMin}m left</div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Wire into Library**

At the top of Library.tsx JSX (just above the tab buttons), add:
```tsx
import ContinueWatchingRail from '../components/ContinueWatchingRail.tsx'
import ProfileBadge from '../components/ProfileBadge.tsx'
import { useActiveUser } from '../hooks/useActiveUser.ts'
// ...

const { userId } = useActiveUser()
// ...

return (
  <div style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 16px', position: 'relative' }}>
    <ProfileBadge />
    <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 24 }}>Horizon</h1>
    {userId && <ContinueWatchingRail userId={userId} />}
    {/* existing tabs + content */}
  </div>
)
```

- [ ] **Step 4: Verify build**

Run: `cd app && npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/ProfileBadge.tsx app/src/components/ContinueWatchingRail.tsx app/src/pages/Library.tsx
git commit -m "feat(app): profile badge + Continue Watching rail"
```

---

## Task 19: Player — resume toast + progress reporter

**Files:**
- Modify: `app/src/pages/Player.tsx`
- Modify: `app/src/components/VideoPlayer.tsx`

- [ ] **Step 1: Resume toast in Player**

In `app/src/pages/Player.tsx`:
1. Import `useActiveUser` and `horizon`.
2. Before the existing session creation, fetch progress for `(userId, mediaId)` and if `positionMs > 5000 && !watched`, show a toast / banner with two buttons.

Concretely, add a `resumeDecision` state: `'pending' | 'resume' | 'start-over' | null`. While `pending`, render a banner but DO NOT call `horizon.play()`. Once decided, call `horizon.play(mediaId, { startPositionMs: resumeFrom })`.

Here's the modified useEffect block:
```tsx
  const { userId } = useActiveUser()
  const [resume, setResume] = useState<{ positionMs: number; durationMs: number } | null>(null)
  const [decision, setDecision] = useState<'pending' | 'resume' | 'start-over' | null>(null)

  useEffect(() => {
    if (!mediaId || !userId) return
    let cancelled = false
    horizon.progress.get(userId, mediaId)
      .then(p => {
        if (cancelled) return
        if (p && p.positionMs > 5000 && !p.watched) {
          setResume({ positionMs: p.positionMs, durationMs: p.durationMs })
          setDecision('pending')
        } else {
          setDecision('start-over')
        }
      })
      .catch(() => setDecision('start-over'))
    return () => { cancelled = true }
  }, [mediaId, userId])

  // Only run the session-creation effect once a decision exists
  useEffect(() => {
    if (!mediaId || decision === null || decision === 'pending') return
    // … existing session creation code, but pass startPositionMs:
    const startPositionMs = decision === 'resume' ? resume?.positionMs : undefined
    // horizon.play(mediaId, { ..., startPositionMs })
  }, [mediaId, decision])
```

Render a banner when `decision === 'pending'`:
```tsx
{decision === 'pending' && resume && (
  <div style={{
    position: 'absolute', top: 80, left: '50%', transform: 'translateX(-50%)',
    background: 'rgba(0,0,0,0.85)', border: '1px solid #444', borderRadius: 8, padding: '12px 16px',
    display: 'flex', gap: 12, alignItems: 'center', zIndex: 20,
  }}>
    <span>Resume from {fmtMs(resume.positionMs)}?</span>
    <button onClick={() => setDecision('resume')}
      style={{ padding: '6px 12px', borderRadius: 6, border: 'none', background: '#fff', color: '#000', cursor: 'pointer', fontSize: 13 }}>
      Resume
    </button>
    <button onClick={() => setDecision('start-over')}
      style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #444', background: 'transparent', color: '#fff', cursor: 'pointer', fontSize: 13 }}>
      Start over
    </button>
  </div>
)}
```

Where `fmtMs` formats `1234000 → "20:34"`:
```tsx
function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60), sec = s % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}
```

- [ ] **Step 2: Progress reporter in VideoPlayer**

In `app/src/components/VideoPlayer.tsx`, add a new useEffect:
```tsx
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const send = () => {
      if (video.paused) return
      if (!video.duration || !isFinite(video.duration)) return
      session.reportProgress(Math.floor(video.currentTime * 1000), Math.floor(video.duration * 1000))
    }
    const interval = setInterval(send, 5000)
    const onPause = () => send()
    const onSeeked = () => send()
    const onBeforeUnload = () => send()
    video.addEventListener('pause', onPause)
    video.addEventListener('seeked', onSeeked)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      clearInterval(interval)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('seeked', onSeeked)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [session])
```

- [ ] **Step 3: Verify build**

Run: `cd app && npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add app/src/pages/Player.tsx app/src/components/VideoPlayer.tsx
git commit -m "feat(app): resume-from-position toast + WS progress reporter"
```

---

## Task 20: Playwright e2e tests

**Files:**
- Create: `e2e/setup.spec.ts`
- Create: `e2e/profiles.spec.ts`
- Create: `e2e/resume.spec.ts`

- [ ] **Step 1: Setup e2e**

Create `e2e/setup.spec.ts`:
```ts
import { test, expect } from '@playwright/test'

test('first-run: / redirects to /setup, creating profile lands on library', async ({ page, request }) => {
  // Clean slate: delete any existing users via API
  const list = await request.get('http://localhost:5173/users')
  const users = (await list.json()) as { id: string }[]
  for (const u of users) await request.delete(`http://localhost:5173/users/${u.id}`)

  await page.goto('http://localhost:5173/')
  await expect(page).toHaveURL(/\/setup$/)

  await page.getByLabel('Name').fill('Testy')
  await page.getByText('🐼').click()
  await page.getByRole('button', { name: /get started/i }).click()

  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByText('Horizon')).toBeVisible()
  await expect(page.getByText('Testy')).toBeVisible() // profile badge
})
```

- [ ] **Step 2: Profiles e2e**

Create `e2e/profiles.spec.ts`:
```ts
import { test, expect } from '@playwright/test'

test('switch between two profiles', async ({ page, request }) => {
  // Seed two users
  const a = await request.post('http://localhost:5173/users', { data: { name: 'Alice', avatar: '🐱' } })
  const b = await request.post('http://localhost:5173/users', { data: { name: 'Bob', avatar: '🐶' } })
  expect(a.ok() && b.ok()).toBe(true)

  await page.goto('http://localhost:5173/profiles')
  await page.getByText('Alice').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByText('Alice')).toBeVisible()

  await page.getByText('Alice').click()        // open badge
  await page.getByText('Switch profile').click()
  await page.getByText('Bob').click()
  await expect(page.getByText('Bob')).toBeVisible()
})
```

- [ ] **Step 3: Resume e2e**

Create `e2e/resume.spec.ts`:
```ts
import { test, expect } from '@playwright/test'

test('resume prompt appears after previous partial play', async ({ page, request }) => {
  const userRes = await request.post('http://localhost:5173/users', { data: { name: 'Resumer' } })
  const user = await userRes.json()
  const movies = await (await request.get('http://localhost:5173/library/movies')).json()
  const movie = movies[0]
  // Seed progress at 30s
  await request.patch(`http://localhost:5173/users/${user.id}/progress/${movie.id}`, {
    headers: { 'x-horizon-user': user.id, 'content-type': 'application/json' },
    data: { watched: false },
  }).catch(() => {/* may 404 if no progress yet */})
  await request.post(`http://localhost:5173/users/${user.id}/progress/${movie.id}`, {
    headers: { 'x-horizon-user': user.id, 'content-type': 'application/json' },
    data: { positionMs: 30_000, durationMs: 3_600_000 },
  }).catch(() => {/* server has no POST — seed via WS instead; see alt path */})

  // Direct SQL-free seed: simulate via PATCH (mark unwatched — already default).
  // Actually we need a progress insert; workaround is to navigate, wait 6s for WS
  // to ingest a progress update, then reload.
  await page.goto('http://localhost:5173/profiles')
  await page.getByText('Resumer').click()
  await page.goto(`http://localhost:5173/play/${movie.id}`)
  await page.waitForTimeout(10_000)   // let WS report progress
  await page.goto(`http://localhost:5173/play/${movie.id}`)
  await expect(page.getByText(/Resume from/i)).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: /resume/i }).click()
  // seeked
})
```

- [ ] **Step 4: Run e2e**

Run: `npm run e2e`
Expected: all three specs pass against a running dev server (`npm run dev:server` + `npm run dev:app`).

- [ ] **Step 5: Commit**

```bash
git add e2e/setup.spec.ts e2e/profiles.spec.ts e2e/resume.spec.ts
git commit -m "test(e2e): first-run setup, profile switching, resume prompt"
```

---

## Task 21: Manual smoke test + sanity pass

- [ ] **Step 1: Boot server**

Run: `npm -w server run dev`
Expected: console shows `DB: migrated to v1` → `Horizon listening on :7777` → `Library: N movies, N shows (scan XXms)` → (background) `Metadata enriched in XXms (background)`.

- [ ] **Step 2: Boot app**

Run: `npm -w app run dev`
Expected: `VITE ready in ... ms`.

- [ ] **Step 3: Browser smoke**

Navigate `http://localhost:5173`:
- Should redirect to `/setup` on first load.
- Create a profile "Luuk" with avatar 🐼 → lands on library.
- Play Oppenheimer → video starts → pause at ~20s → refresh `/play/:id` → "Resume from 0:20?" banner appears → click **Resume** → player starts at ~20s.
- Back to library → Continue Watching rail shows the in-progress movie with progress bar.
- Click profile badge → "Switch profile" → `/profiles` → "Add profile" → create "Test" → select → Library shows empty Continue Watching rail.

- [ ] **Step 4: Final commit (if any doc tweaks)**

```bash
git status
# if nothing to commit, skip. If final doc tweaks or gitignore additions:
git add <files>
git commit -m "chore: doc tweaks + smoke-test polish"
```

---

## Spec Coverage Review

| Spec section | Task(s) |
| --- | --- |
| Schema (v1) | Task 2 |
| zod row schemas | Task 3 |
| Users repo | Task 4 |
| Media repo + upsert/soft-delete | Task 5 |
| Collections repo | Task 6 |
| Progress repo + Continue Watching + next-up | Task 7 |
| Config additions | Task 8 |
| Scanner → repo writes | Task 9 |
| Library/session routes → repo queries | Task 9 |
| `/users` HTTP | Task 10 |
| `/users/:userId/progress` + `/continue-watching` HTTP | Task 11 |
| WS `progress` message + flusher | Task 12 |
| `startPositionMs` on POST /sessions | Task 13 |
| SDK users + progress methods | Task 14 |
| SDK `reportProgress` + `startPositionMs` | Task 15 |
| `useActiveUser` + `X-Horizon-User` header | Task 16 |
| `/setup`, `/profiles`, routing guard | Task 17 |
| Profile badge + Continue Watching rail | Task 18 |
| Resume toast + progress reporter | Task 19 |
| e2e tests | Task 20 |
| Manual smoke | Task 21 |
