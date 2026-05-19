# Plan for issue #14: ServerSettings module + env-overlay bootstrap (no UI yet)

## Goal
Introduce a `server_settings` singleton row (Library / Metadata / Playback knobs) plus a `serverSettings` module that owns reading and writing it, with a one-time `HORIZON_*` env-overlay bootstrap pass on first boot post-upgrade. Convert `watchedThresholdPct` (in the progress repo) from the frozen `Config` to a live `serverSettings.get()` read so the slice proves the runtime read path end-to-end. No HTTP routes, no UI.

## Scope
- Expected files changed: **10**
- Expected lines changed: **~520**
- Within soft caps: **no** (10 of 8 files; ~520 of 400 lines)
- Justification: the slice naturally fans out across (a) one DB migration + (b) one new self-contained `serverSettings` module (~200 lines, carries the per-knob env-parse mapping for 13 settings + zod row parsing + event emitter + bootstrap) + (c) the passive-consumer conversion in `progress.ts` + (d) wiring in `index.ts` + (e) **four test touches** (the new `serverSettings.test.ts`, the migration test extension, and three existing progress-repo test setups that pass `watchedThresholdPct: 90` — each gets a one-token change to match the new thunk-shaped opts) + (f) CONTEXT.md. Module tests are ~200 lines because the AC explicitly enumerates five distinct bootstrap cases + five module-shape cases. Hard caps (20 / 1500) easily respected. Splitting further (e.g., separate `serverSettings/bootstrap.ts` + `serverSettings/index.ts`) would inflate file count for no readability gain.

## Files to change

- `apps/server/src/db/migrations.ts` — append `V4_SQL`: `CREATE TABLE server_settings (...)` with one INTEGER column per knob in the documented set (Library, Metadata, Playback — see "Schema"), `seeded_from_env INTEGER NOT NULL DEFAULT 0`, `updated_at INTEGER NOT NULL`, single-row guard `id INTEGER PRIMARY KEY CHECK (id = 1)`. Follow with `INSERT INTO server_settings (id, ..., seeded_from_env, updated_at) VALUES (1, <hardcoded defaults>, 0, <ts>)`. Append `{ version: 4, sql: V4_SQL }` to `MIGRATIONS`. Comment above SQL: rationale = singleton row vs k/v + first-boot env-overlay (cross-link planned ADR path `docs/adr/0002-server-settings-singleton-with-env-overlay.md`).

- `apps/server/src/serverSettings.ts` — **new** module. Exports:
  - `interface ServerSettingsValues` — 13 typed fields (numbers / booleans).
  - `interface ServerSettingsChange { prev: ServerSettingsValues; next: ServerSettingsValues; diff: Partial<ServerSettingsValues> }`.
  - `interface ServerSettings { get(): ServerSettingsValues; update(patch: Partial<ServerSettingsValues>): ServerSettingsValues; on(event: 'change', listener: (c: ServerSettingsChange) => void): () => void }`.
  - `createServerSettings(db: DatabaseSync): ServerSettings` — uses `node:events`' `EventEmitter` privately; caches the parsed row and re-reads it after writes (DB writes go through `update`; single owner).
  - `bootstrapFromEnv(db, env: NodeJS.ProcessEnv | Record<string,string|undefined> = process.env, now = Date.now): void` — atomic: reads `seeded_from_env`; if 0, parses each `HORIZON_*` env (local `envInt` / `envBool` mirror `config.ts`; non-empty raw string == "set"), composes a single `UPDATE server_settings SET <staged cols> = ?, ..., seeded_from_env = 1, updated_at = ? WHERE id = 1`. If 1, no-op.
  - Internal `SETTINGS_REGISTRY` (column / envVar / kind: 'int'|'bool' / default / camelCase key) drives the zod row schema, the bootstrap loop, and `update`'s SQL fragments — single source of truth.

- `apps/server/src/repos/progress.ts` — change `ProgressRepoOpts.watchedThresholdPct: number` → `getWatchedThresholdPct: () => number`. In `setProgress` (`progress.ts:86`), read at call time: `const threshold = opts.getWatchedThresholdPct()`. Type-only change otherwise.

- `apps/server/src/index.ts` — after `migrate(db)` (line 24) and before constructing repos: call `bootstrapFromEnv(db)` **then** `const serverSettings = createServerSettings(db)` (bootstrap mutates the row out-of-band, so the factory's first cache read must see the post-bootstrap row). Replace `watchedThresholdPct: cfg.watchedThresholdPct` (line 29) with `getWatchedThresholdPct: () => serverSettings.get().watchedThresholdPct`. Leave `Config.watchedThresholdPct` populated by `loadConfig()`; production code no longer reads it — removal is a one-line follow-up.

- `apps/server/test/db.migrate.test.ts` — extend with: `PRAGMA user_version === 4` after fresh migrate; `server_settings` listed in `sqlite_master`; `INSERT … VALUES (2, ...)` throws (CHECK); exactly one row with `id=1`, `seeded_from_env=0`, and `watched_threshold_pct=90` after migrate (defaults match registry).

- `apps/server/test/serverSettings.test.ts` — **already staged untracked** (`?? apps/server/test/serverSettings.test.ts`). All 11 required cases are present (see "Tests"). Verify red before implementing the module; do not rewrite.

- `apps/server/test/repos.progress.test.ts` — single-line setup tweak at line 13: `{ watchedThresholdPct: 90 }` → `{ getWatchedThresholdPct: () => 90 }`. Rest unchanged.

- `apps/server/test/routes.progress.test.ts` — same single-line setup tweak at line 24.

- `apps/server/test/ws.progress.test.ts` — same single-line setup tweak at lines 31 and 60.

- `CONTEXT.md` — add a new top-level `## Configuration` section (between `## Identity` and `## Library`) with a `### ServerSettings` entry: explains the singleton row + env-overlay-once invariant, why the row is keyed `id=1` (not k/v), the `seeded_from_env` semantic, the fact that consumers should call `serverSettings.get()` rather than `loadConfig()` for live settings, and that `metadata_max_age_*_days` is stored in **days** (the env unit) — consumers convert to ms at the edge. Cross-link `apps/server/src/serverSettings.ts`.

### Schema (server_settings columns)

Decided from the existing `Config` knobs by isolating those that are operator-tunable at runtime (i.e., not deployment-shaped like `port` / `dbPath` / `cacheDir` / `corsOrigins` / `devSeedEnabled`, not secrets like `tmdbToken`, not source-of-truth-shaped like `moviesRoots` / `showsRoots`). The nested `toneMap` block and `forceEncoder` are explicitly **deferred** to a later slice — see "Out of scope".

**Library (4):** `scan_concurrency` INTEGER (4), `scan_cron_hour` INTEGER (3), `watch_fs` INTEGER bool (0), `watch_debounce_ms` INTEGER (5000).

**Metadata (4):** `metadata_batch_size` INTEGER (50), `metadata_max_age_movie_days` INTEGER (30), `metadata_max_age_show_days` INTEGER (7), `metadata_max_age_episode_days` INTEGER (60). Days, not ms — env var is in days; less lossy across get/update round-trips.

**Playback (5):** `watched_threshold_pct` INTEGER (90), `max_sessions` INTEGER (4), `ws_grace_ms` INTEGER (10000), `ws_attach_ms` INTEGER (10000), `max_renditions` INTEGER (3).

All columns INTEGER (booleans 0/1 — matches existing `watch_progress.watched` convention). Numeric ranges (e.g., `scan_cron_hour` 0–23) are **not** enforced via SQL CHECK in this slice — bootstrap parsing and the future route layer own validation. See Risks.

## Out of scope

- **Writing the ADR `docs/adr/0002-server-settings-singleton-with-env-overlay.md`.** Referenced in issue body but not in AC; `docs/adr/` does not yet exist in the repo. Migration comment + CONTEXT.md cross-link the planned path so reviewers know where it should land.
- **HTTP routes** for reading/writing settings (`GET /settings`, `PATCH /settings`). Issue body explicitly excludes them.
- **Web/TV UI** for settings.
- **Migrating the rest of `Config` into `server_settings`.** `forceEncoder`, the nested `toneMap` block, `moviesRoots`, `showsRoots`, `corsOrigins`, `tmdbToken`, `port`, `dbPath`, `cacheDir`, `devSeedEnabled` all stay in `Config`/env. Future slices may move the operator-tunable ones; deployment-shaped + secret knobs stay in env permanently.
- **Removing `Config.watchedThresholdPct`.** The field stays — `loadConfig()` still parses it — to keep diff bounded and the `baseCfg` helper in `session.playback.test.ts:39` unbroken. Production code no longer reads it; cleanup is a follow-up.
- **Converting other passive consumers** beyond `watchedThresholdPct`. AC asks for *at least one*. Doing more (e.g., `maxSessions` into `SessionManager`, `wsGraceMs` into the WS layer) would cascade test-setup changes and inflate scope past the hard cap.
- **Per-column env-overlay on future migrations.** Once `seeded_from_env=1` flips, any v5+ migration that adds a column gets only its hardcoded default — no `HORIZON_*` overlay. Documented in Risks; mitigation is a per-migration convention, not a code change today.
- **Hot-reload semantics for other live consumers.** Once the read path is proven for `watchedThresholdPct`, the same thunk pattern generalises — but extending it is deferred.
- **SQL `CHECK` constraints on column ranges.** Bootstrap parser + (future) route-layer Zod own range validation.

## Steps

1. **Verify failing.** Run `npm -w @horizon/server run test -- serverSettings db.migrate` — `serverSettings.test.ts` is already staged (untracked) with all 11 required cases (`bootstrapFromEnv` × 5, `createServerSettings` × 6); confirm it fails red because the module doesn't exist yet.
2. Extend `apps/server/test/db.migrate.test.ts` with the four v4 cases. Re-run migrate tests — confirm red.
3. Implement `V4_SQL` in `apps/server/src/db/migrations.ts` and append `{ version: 4, sql: V4_SQL }` to `MIGRATIONS`. Run `npm -w @horizon/server run test -- db.migrate` — green.
4. Implement `apps/server/src/serverSettings.ts`:
   - Define `SETTINGS_REGISTRY` (one entry per column: `column`, `key` camelCase, `envVar`, `kind: 'int'|'bool'`, `default`). 13 entries.
   - Derive the zod row schema from the registry using `intBool`-style transform (copy the one-liner from `db/rowSchemas.ts:7`; keep module self-contained).
   - `createServerSettings(db)`:
     - Prepare a `SELECT * FROM server_settings WHERE id = 1` statement; cache.
     - `let cached: ServerSettingsValues | null = null`. `get()` lazy-initialises on first call.
     - `update(patch)`: validate every patch key is a known camelCase key (throw on stray keys), build a single `UPDATE server_settings SET <staged_cols> = ?, updated_at = ? WHERE id = 1` from patch keys, run it, re-read the row, compute `diff` between prev cache and new, emit `change`, return the new value.
     - `on('change', fn)`: returns an unsubscribe thunk; wraps `EventEmitter.on` + matching `off`.
   - `bootstrapFromEnv(db, env = process.env, now = Date.now)`:
     - One statement: `SELECT seeded_from_env FROM server_settings WHERE id = 1`.
     - If `seeded_from_env = 1`, return immediately.
     - Else: for each entry in `SETTINGS_REGISTRY`, read `env[entry.envVar]`; if non-empty string, parse (`parseInt` for `'int'` with NaN/negative guard mirroring `config.ts:envInt`; `'1' | 'true' | 'yes'` truthy for `'bool'`) and stage. Compose one `UPDATE server_settings SET <staged cols> = ..., seeded_from_env = 1, updated_at = ? WHERE id = 1`. Even when nothing staged, still flip `seeded_from_env = 1`.
5. Run `npm -w @horizon/server run test -- serverSettings` — green except for the passive-consumer case.
6. Update `apps/server/src/repos/progress.ts:29,86` per "Files to change".
7. Update the three progress test files: one-line setup tweak per file (`repos.progress.test.ts:13`, `routes.progress.test.ts:24`, `ws.progress.test.ts:31,60`).
8. Update `apps/server/src/index.ts` per "Files to change" — `bootstrapFromEnv` **before** `createServerSettings`, then thunk-wired `getWatchedThresholdPct` into `createProgressRepo`.
9. Run `npm -w @horizon/server run test` — full suite green.
10. Update `CONTEXT.md` with the `### ServerSettings` entry under a new `## Configuration` section.
11. Run verification commands (see below). Commit.

## Tests

**Test-first: yes.** The new `serverSettings.test.ts` is already drafted (untracked) and must fail red before any production change.

### `apps/server/test/db.migrate.test.ts` (extend)
1. After `migrate(:memory:)`, `PRAGMA user_version === 4`.
2. `sqlite_master` lists `server_settings` after fresh migrate.
3. `INSERT INTO server_settings (id, ...) VALUES (2, ...)` throws (CHECK constraint).
4. After migrate on fresh DB, exactly one row with `id=1`, `seeded_from_env=0`, `watched_threshold_pct=90` (smoke-test that registry defaults match the migration's hardcoded defaults).

### `apps/server/test/serverSettings.test.ts` (already staged, 11 cases)
**bootstrapFromEnv:**
1. Fresh install (no envs set) — sets `seeded_from_env=1` with all defaults; spot-checks `watched_threshold_pct=90`, `max_sessions=4`, `watch_fs=0`, `scan_concurrency=4`.
2. Upgrade (envs override defaults) — `HORIZON_WATCHED_THRESHOLD_PCT=75`, `HORIZON_MAX_SESSIONS=8`, `HORIZON_WATCH_FS=1`, `HORIZON_METADATA_MAX_AGE_MOVIE_DAYS=14` → row reflects each; unset stay at default; flag flips to 1.
3. Second boot — first call with `…_PCT=75`, second call with `…_PCT=50`; row still 75 (no-op since flag is 1).
4. Invalid env value (`'banana'`) → falls back to default; flag still flips.
5. Empty env string (`''`) → treated as unset (matches `config.ts:envInt`).

**createServerSettings:**
6. `get()` returns typed live row — `typeof vals.watchedThresholdPct === 'number'`, `typeof vals.watchFs === 'boolean'`, etc.
7. `update({ watchedThresholdPct: 60 })` → `get().watchedThresholdPct === 60`; direct SELECT confirms.
8. `update` emits typed `change` once with `{ prev, next, diff: { watchedThresholdPct: 60, maxSessions: 2 } }`.
9. `update({ notAColumn: 1 } as any)` throws.
10. `on('change', spy)` returns unsubscribe; after thunk call, subsequent `update` does not invoke spy.
11. Passive consumer wired with `getWatchedThresholdPct: () => ss.get().watchedThresholdPct` — `setProgress` at 80% returns `watched=false`, then `ss.update({ watchedThresholdPct: 70 })`, then `setProgress` at 80% again returns `watched=true`. End-to-end read path.

### Existing tests touched
- `repos.progress.test.ts:13`, `routes.progress.test.ts:24`, `ws.progress.test.ts:31,60` — one-token setup tweak per occurrence (`watchedThresholdPct: 90` → `getWatchedThresholdPct: () => 90`). Assertions unchanged.
- `config.test.ts` — untouched; `Config.watchedThresholdPct` still populated.
- `session.playback.test.ts:39` `baseCfg` helper — untouched; field still on `Config`.

## Verification commands
- `npm -w @horizon/server run typecheck`
- `npm -w @horizon/server run test`
- `npm test` *(root — runs server + sdk vitest)*
- `npm -w @horizon/web run build` *(catches incidental type breakage)*

## Risks / open questions

- **Bootstrap ordering vs cached `serverSettings.get()`.** `bootstrapFromEnv` mutates the row directly via SQL (not through `update()`), so the cache inside `createServerSettings` would be stale if we constructed the store *before* bootstrap. Mitigation: call `bootstrapFromEnv(db)` **first**, then `createServerSettings(db)`. Steps 4 and 8 spell this out.
- **Future schema additions don't get env-overlay.** Once `seeded_from_env=1` flips, any v5+ migration that adds a column gets only the hardcoded default — `HORIZON_NEW_KNOB` set between upgrades won't apply. Documented out-of-scope; mitigation is a per-migration convention (a v5 that adds a column runs its own targeted overlay for that column's env var). Flag in CONTEXT.md.
- **Concurrent `update()` callers.** Module emits `change` synchronously after the SQL `UPDATE`. No transactional guard against interleaving (no routes yet → only test code can hit this); cache re-reads after every write, so eventual consistency holds. Add a real lock when an HTTP write route lands.
- **`update(patch)` patch typing.** Patch is `Partial<ServerSettingsValues>`. Implementation rejects keys not in the registry (cast-and-pass would silently no-op otherwise). Test #9 covers.
- **`watched_threshold_pct` stored as integer percent (not float).** Matches the existing env var (`HORIZON_WATCHED_THRESHOLD_PCT=90` → int). Implementation must NOT divide on the way in/out — divide-by-100 stays in `computeWatched` (`progress.ts:46`).
- **Days vs ms in metadata-max-age columns.** Stored as **days** (env-var unit), not ms (`Config` runtime unit). Conversion to ms happens at the consumer when those settings are wired into `MetadataRefreshWorker` in a later slice. CONTEXT.md notes this so a future consumer doesn't pass `metadataMaxAgeMovieDays * 1` into a `* ms` API.
- **No SQL `CHECK` ranges.** A future operator-write via the (yet-to-build) PATCH route could persist `watched_threshold_pct = 9001` without DB pushback. Bootstrap parser doesn't see that path (only env). Add Zod range checks at the route layer when it lands.
- **ADR doesn't exist yet.** Issue body references `docs/adr/0002-…` but AC doesn't ask for it. Migration comment + CONTEXT.md cross-link the planned path so the dangling reference is short-lived.
- **Test env isolation.** `serverSettings.test.ts` passes the env object explicitly to `bootstrapFromEnv(db, envObject)` rather than mutating `process.env` — cleaner than the existing `beforeEach delete process.env.*` pattern in `config.test.ts`; fewer cross-test contamination footguns.
