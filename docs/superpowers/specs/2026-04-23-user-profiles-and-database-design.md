# User Profiles + Database Persistence — Design

**Status:** Approved (2026-04-23)
**Scope:** Phase 1B from the product roadmap — adds local user profiles, watch progress, and moves the media catalog from an in-memory `LibraryIndex` to SQLite. No authentication.

## Goals

- Multi-profile (household-style) without passwords or logins.
- Persistent watch progress per profile, with a Plex/Netflix-style Continue Watching rail.
- Move the media catalog into a queryable store so future features (ratings, tags, custom collections, search) become single-query.
- Preserve today's cold-start speed — the DB must not add meaningful latency to the hot path.

## Non-goals

- User authentication, PIN codes, or access control (deferred).
- Cross-device progress sync (single-server assumed).
- Music or photos (schema allows future `kind` values, but only movies/shows/episodes in this ship).
- Migrating probe / TMDB JSON caches into SQLite (they stay on disk — already fast).

## Stack decisions

- **DB driver**: `node:sqlite` (Node 24+ built-in). Sync API, zero native build, zero deps.
- **Validation**: `zod` at HTTP boundaries and for parsing DB JSON columns. Inferred TS types throughout.
- **Query layer**: hand-written SQL in Repository modules. No ORM.
- **WAL mode + foreign keys on** via `PRAGMA` at connection open.

## Schema (migration v1)

```sql
PRAGMA user_version = 1;
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE users (
  id          TEXT PRIMARY KEY,             -- crypto.randomUUID() (v4)
  name        TEXT NOT NULL,
  avatar      TEXT,                          -- emoji char or null
  preferences TEXT NOT NULL DEFAULT '{}',    -- JSON blob
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- One table for all media. Hierarchy via parent_id.
--   kind='movie'    parent_id=null   — file-backed, standalone
--   kind='show'     parent_id=null   — container, no file
--   kind='episode'  parent_id=show   — file-backed, (season,episode) = sort key
CREATE TABLE media_items (
  id              TEXT PRIMARY KEY,           -- sha1(file_path) or sha1(dir_path); stable across rescans
  kind            TEXT NOT NULL CHECK(kind IN ('movie','show','episode')),
  parent_id       TEXT REFERENCES media_items(id) ON DELETE CASCADE,

  title           TEXT NOT NULL,
  sort_year       INTEGER,
  season          INTEGER,                    -- episode only
  episode         INTEGER,                    -- episode only

  file_path       TEXT UNIQUE,                -- null for kind='show'
  duration_sec    REAL,
  resolution      TEXT,
  video_codec     TEXT,
  container       TEXT,
  hdr             TEXT,                       -- JSON {dv,hdr10,hdr10plus,dvProfile?}
  audio_tracks    TEXT,                       -- JSON array
  subtitle_tracks TEXT,                       -- JSON array
  mtime_ms        INTEGER,
  size_bytes      INTEGER,

  external_ids    TEXT NOT NULL DEFAULT '{}', -- JSON {tmdb,tvdb,imdb}
  metadata        TEXT,                       -- JSON normalized TMDB blob

  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  deleted_at      INTEGER                     -- soft-delete
);

CREATE INDEX idx_media_kind   ON media_items(kind)                      WHERE deleted_at IS NULL;
CREATE INDEX idx_media_parent ON media_items(parent_id, season, episode) WHERE deleted_at IS NULL;
CREATE INDEX idx_media_title  ON media_items(title)                     WHERE deleted_at IS NULL;
CREATE INDEX idx_media_path   ON media_items(file_path)                 WHERE deleted_at IS NULL;

CREATE TABLE collections (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE collection_items (
  collection_id TEXT NOT NULL REFERENCES collections(id)   ON DELETE CASCADE,
  media_id      TEXT NOT NULL REFERENCES media_items(id)   ON DELETE CASCADE,
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
```

### Notes
- Movie/episode `id` is the sha1 of `file_path` (same hashing as today) → watch progress survives rescans as long as the file path is stable.
- `file_path` is `UNIQUE` but NULL-tolerant: SQLite allows multiple NULLs under `UNIQUE`, so shows (no file) coexist with movies/episodes.
- Continue Watching uses a single `watch_progress JOIN media_items` query. Polymorphic `media_id` is enforceable because media_items.id is unique across kinds.
- Partial indexes on `WHERE deleted_at IS NULL` keep list queries cheap without needing to exclude tombstones in WHERE clauses (query planner picks the partial index automatically).

## Module layout

### New server modules

```
server/src/db/
  index.ts          # singleton DatabaseSync, apply migrations on boot, expose typed DB
  schema.sql        # DDL from above as one file
  migrations.ts     # numbered migrations driven by PRAGMA user_version
  rowSchemas.ts     # zod schemas matching table rows → inferred TS types

server/src/repos/
  users.ts          # createUser, listUsers, getUser, updateUser, deleteUser
  media.ts          # upsertMovie/Show/Episode, softDeleteMissing, listMovies, listShows,
                    #   getById, getEpisodes(showId), getShowWithSeasons
  collections.ts    # replaceAll(detected), list
  progress.ts       # setProgress, getProgress, markWatched, listContinueWatching(userId)
```

### New server routes

```
server/src/routes/
  users.ts          # GET/POST/PATCH/DELETE /users, /users/:id
  progress.ts       # GET /users/:userId/continue-watching
                    # GET/PATCH/DELETE /users/:userId/progress/:mediaId
```

### Modified server files

```
server/src/
  index.ts               # open DB → migrate → start scan → listen
  config.ts              # + HORIZON_DB_PATH, HORIZON_WATCHED_THRESHOLD_PCT
  scanner/scanner.ts     # replace LibraryIndex with DB writes via media repo
  routes/library.ts      # query media repo instead of index
  routes/sessions.ts     # media lookup via repo.getById
  ws/handler.ts          # + 'progress' message dispatch + flush timer
  ws/messages.ts         # + ProgressMessage schema
  server.ts              # registerUsers, registerProgress
```

### SDK changes

```
sdk/src/
  client.ts     # users CRUD, progress reads, continueWatching()
  session.ts    # reportProgress(positionMs, durationMs) — via WS; flush on disconnect
  types.ts      # User, WatchProgress, ContinueWatchingItem
```

### Client changes

```
app/src/
  App.tsx                        # + /setup, /profiles routes; guard by active user
  horizon.ts                     # X-Horizon-User header from localStorage
  hooks/useActiveUser.ts         # localStorage reader/writer + subscription
  pages/Setup.tsx                # first-run profile creation form
  pages/ProfilePicker.tsx        # grid of profiles + add/edit/delete
  pages/Library.tsx              # + <ContinueWatchingRail> at top
  pages/Player.tsx               # resume prompt on mount; hooks up progress reporter
  components/ContinueWatchingRail.tsx
  components/ProfileBadge.tsx    # top-right avatar + menu
```

### Deleted

- `LibraryIndex` (scanner.ts). Routes and session lookup go through repos now.

## HTTP API

### Users

```
POST   /users                   body: { name, avatar? }                     → User
GET    /users                                                               → User[]
GET    /users/:id                                                           → User | 404
PATCH  /users/:id               body: { name?, avatar?, preferences? }      → User
DELETE /users/:id                                                           → 204

Errors: 400 invalid-input · 404 user-not-found · 409 name-taken
```

### Progress

All require `X-Horizon-User: <id>` header. 400 `no-user` if missing or pointing at a deleted user. `:userId` in the path must match the header (defense against stale clients).

```
GET    /users/:userId/continue-watching          → ContinueWatchingItem[]
GET    /users/:userId/progress/:mediaId          → WatchProgress | 404
PATCH  /users/:userId/progress/:mediaId          body: { watched: boolean } → WatchProgress
DELETE /users/:userId/progress/:mediaId                                     → 204
```

Payload shapes:

```ts
User               = { id, name, avatar, preferences, createdAt, updatedAt }
WatchProgress      = { mediaId, positionMs, durationMs, watched, updatedAt }
ContinueWatchingItem = {
  mediaId, kind: 'movie' | 'episode',
  positionMs, durationMs, percent, updatedAt,
  media: MediaItem,           // movie or episode row (enriched metadata included)
  show?: MediaItem,           // present when kind='episode'
}
```

## Continue Watching algorithm

Input: `userId`.

1. Select all rows from `watch_progress` where `user_id = :userId AND watched = 0`, ordered by `updated_at DESC`.
2. Join each to its `media_items` row (skip if soft-deleted).
3. For `kind='movie'` rows: include directly.
4. For `kind='episode'` rows: dedupe per `parent_id` (show) — only the most-recent one per show survives. Attach the show row via `show` field.
5. **Next-up promotion** (second pass): for every show the user has ever touched (any episode, any watched state), find the latest-touched episode. If that episode is `watched=1`, look up the next episode in `(season, episode)` order that is NOT watched. If one exists, synthesize a Continue-Watching entry with `positionMs=0, duration_ms=<next ep duration>`, sorted to the top by the original row's `updated_at`.
6. Merge, sort by `updated_at DESC`, cap at 20.

## WebSocket — progress reporting

Adds one message type to the existing handler:

```ts
// client → server, during playback
{ type: 'progress', positionMs: number, durationMs: number }
```

Server contract:
- Each incoming `progress` message updates `session.lastProgressMs` in memory.
- Background timer per session: `setInterval(30_000)` — if dirty, flush to `watch_progress` via repo, clear dirty flag.
- On WS close + on `sessions.destroy`: final flush.
- Watched flag set when `positionMs / durationMs ≥ 0.9` OR `durationMs - positionMs ≤ 30_000`. Threshold configurable via `HORIZON_WATCHED_THRESHOLD_PCT` (default 90).

Client contract:
- `VideoPlayer` sets `setInterval(5000)` to call `session.reportProgress(...)`.
- Additional calls on `pause`, `seeked`, and `beforeunload`.
- `session.disconnect()` triggers a final flush server-side as the WS close fires.

## Client UX flow

### Routing guard

On boot, `App.tsx` fetches `GET /users`:
- `users.length === 0` → redirect any route to `/setup`.
- `users.length > 0 && !activeUser` → redirect to `/profiles`.
- Active user valid → render requested route.

### First-run `/setup`

Single centered card:
- Name input (1–40 chars, required).
- Emoji picker strip: 🐱 🐶 🦊 🐼 🐸 🚀 🎮 🎬 🎨 👤. Null allowed.
- Submit → `POST /users` → write localStorage → navigate `/`.

### `/profiles`

Grid of profile cards. Each card:
- Circular avatar (or name initial fallback).
- Click → set active user, navigate `/`.
- Hover → edit + delete icons.
- Final "Add profile" tile opens inline create form.

### Library

Above existing Movies/Shows/Collections tabs: `<ContinueWatchingRail userId={active.id} />`.
- Horizontal scroll row, up to 20 cards.
- Each card: poster (movie) or episode still, overlay `S01E04 · 12m left` / `43% watched`.
- Click → `/play/:mediaId`. Empty list → rail hidden entirely.

### Player

On mount, fetch `GET /users/:userId/progress/:mediaId`:
- `positionMs > 5000 && !watched` → toast with two actions: **Resume from 12:34** / **Start over**.
- Resume → include `startPositionMs` in the session creation request.
- Start over → session starts at 0.

During playback, `VideoPlayer` posts progress over the WS every 5 s (skipped when paused).

### Profile badge

Top-right of every page. Shows avatar + name. Dropdown:
- Current user (read-only).
- Switch profile → `/profiles`.
- Edit profile → inline modal.
- Delete profile → confirm dialog. DELETE /users/:id cascades to watch_progress.

## On-disk layout

```
<cacheDir>/                              (HORIZON_CACHE_DIR)
├── horizon.db                           (NEW — SQLite, ~1MB per ~1000 media items)
├── horizon.db-wal                       (auto — WAL mode)
├── horizon.db-shm
├── probe/<8-char-hash>.json             (unchanged)
└── metadata/
    ├── tmdb/<ns>/<hash>.json            (unchanged)
    └── images/<hash>.jpg                (unchanged)
```

## DB migration mechanism

```ts
// db/migrations.ts
interface Migration { version: number; sql: string }
const MIGRATIONS: Migration[] = [
  { version: 1, sql: /* schema.sql contents */ },
]

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
    } catch (err) {
      db.exec('ROLLBACK'); throw err
    }
  }
}
```

No downgrade path. Corruption recovery: delete `horizon.db`, reboot, scanner rebuilds.

## First-boot behavior

1. Open DB at `<cacheDir>/horizon.db`. Create file if missing.
2. `migrate()` → apply v1 schema.
3. `app.listen()` (server immediately accepting traffic).
4. Scanner walks FS → probes (JSON cache accelerates) → upserts `media_items` via repo. Nothing to soft-delete.
5. TMDB enrichment runs in background after scan, updating rows with `metadata`.
6. Client hits `/` → no users in DB → `/setup` → create profile → localStorage set → library renders.

Subsequent boots: same steps, but upsert is mostly no-op (probe cache hits, `mtime_ms` unchanged) and soft-delete fires on removed files.

## Scanner reconciliation (the interesting behaviors)

- **New file** → insert with `first_seen_at = last_seen_at = now`, `deleted_at = null`.
- **Existing file, unchanged** → `UPDATE last_seen_at` only. Skip ffprobe (cache hit).
- **Existing file, mtime changed** → re-probe, `UPDATE` non-id columns, `id` stable so `watch_progress` doesn't orphan.
- **File disappeared** → `UPDATE … SET deleted_at = now WHERE id IN (previously-seen-but-not-seen-this-scan)`.
- **Deleted file reappears** → `UPDATE … SET deleted_at = NULL`. id matches because sha1 of file path is stable.

Implemented via a `seenIds Set<string>` accumulated during the scan pass; final `softDeleteMissing(seenIds)` query uses a temp table when the set is large.

## Testing strategy

### vitest (server)

- `test/db.migrate.test.ts` — migrations apply cleanly, are idempotent.
- `test/repos.users.test.ts` — CRUD + name uniqueness.
- `test/repos.media.test.ts` — upsert, soft-delete, reincarnation, mtime change, parent relationships, listing semantics.
- `test/repos.collections.test.ts` — rebuild replaces prior, cascade on delete.
- `test/repos.progress.test.ts` — setProgress, watched threshold, continue-watching dedupe, next-up promotion, cap at 20.
- `test/scanner.integration.test.ts` — fake FS tree + fake probe → exact DB state.
- `test/ws.progress.test.ts` — ProgressMessage parses, dispatch writes to mock repo.
- `test/rowSchemas.test.ts` — zod row parsing sanity.

All use `new DatabaseSync(':memory:')` + fresh migrations per test.

### Playwright (e2e)

- `e2e/setup.spec.ts` — landing → `/setup` → create profile → library visible.
- `e2e/profiles.spec.ts` — switch between two profiles, Continue Watching state differs.
- `e2e/resume.spec.ts` — play, pause, reload, resume toast appears, accept → seeks to saved position.

### Manual smoke

- First boot with existing cache: library populates, enrichment finishes in background.
- Play 4K HDR movie, pause at 30s, refresh → resume offered.
- Delete active profile → falls back to `/profiles`.
- Delete + recreate profile with same name → 409.

## Open items (not blockers)

- TMDB enrichment currently runs off in-memory objects; after this change it will update `media_items.metadata` via the repo. Semaphore in `tmdb.ts` stays as-is.
- Next-up logic ignores seasons beyond the latest-touched episode's season boundary. For simplicity the implementation walks `ORDER BY season, episode` with no season grouping — good enough for linear TV.

## Known risks

- **Soft-delete restore semantics**: if a user renames a file, sha1 changes → new `id` row. The old row soft-deletes. Watch progress for the renamed file is lost. Acceptable trade-off; avoiding would require content-hash IDs (expensive on boot).
- **Single-user assumption baked into `X-Horizon-User` header**: it's trivially spoofable. Fine for a home LAN; not fine for internet exposure. Documented as explicit non-goal.
- **WS progress final flush**: if the browser is force-killed, server still eventually sees WS close and flushes the last in-memory progress. If the *server* crashes between the in-memory update and the 30s flush tick, up to ~30s of progress can be lost. Matches Plex.

## Next step

Hand off to `superpowers:writing-plans` to turn this spec into a TDD implementation plan.
