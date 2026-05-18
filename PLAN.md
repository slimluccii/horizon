# Plan for issue #14: ServerSettings module + env-overlay bootstrap (no UI yet)

## Goal
Introduce a `server_settings` singleton row (Library / Metadata / Playback knobs) plus a `serverSettings` module that owns reading and writing it, with a one-time `HORIZON_*` env-overlay bootstrap on first boot post-upgrade. Convert `watchedThresholdPct` (in the progress repo) from the frozen `Config` to a live `serverSettings.get()` read so the slice proves the runtime read path end-to-end. No HTTP routes, no UI.

## Scope
- Expected files changed: **10**
- Expected lines changed: **~520**
- Within soft caps: **no** (10 of 8 files; ~520 of 400 lines)
- Justification: the slice naturally fans out across (a) one DB migration + (b) one new self-contained `serverSettings` module that owns the settings registry, zod row parsing, env-overlay bootstrap, getter, mutator with typed `change` emitter + (c) the passive-consumer conversion in `progress.ts` + (d) wiring in `index.ts` + (e) **four test files** (the new `serverSettings.test.ts`, the migration test, and the three existing progress-repo test setups that pass `watchedThresholdPct: 90` — each gets a one-token change to match the new thunk-shaped opts) + (f) CONTEXT.md. Module file is ~200 lines because it carries the per-knob env-parse mapping for 13 settings; module tests are ~200 lines because the AC explicitly enumerates five distinct test cases (fresh / upgrade / second-boot / event / passive-consumer). Hard caps (20 / 1500) easily respected. Splitting further (e.g., separate `serverSettings/bootstrap.ts` + `serverSettings/index.ts`) would inflate file count for no readability gain.

## Files to change

- `apps/server/src/db/migrations.ts` — add `V4_SQL`: `CREATE TABLE server_settings (...) ` with one column per knob in the documented set (Library, Metadata, Playback — see "Schema" below), `seeded_from_env INTEGER NOT NULL DEFAULT 0`, `updated_at INTEGER NOT NULL`, single-row guard `id INTEGER PRIMARY KEY CHECK (id = 1)`. Followed by `INSERT INTO server_settings (id, ..., seeded_from_env, updated_at) VALUES (1, <hardcoded defaults>, 0, <ts>)`. Append `{ version: 4, sql: V4_SQL }` to `MIGRATIONS`. Comment above the SQL: rationale = singleton row vs k/v + first-boot env-overlay (cross-link to the planned ADR path).

- `apps/server/src/serverSettings.ts` — **new** module. Exports:
  - `interface ServerSettingsValues` — all 13 typed fields (numbers / booleans).
  - `interface ServerSettingsChange { prev: ServerSettingsValues; next: ServerSettingsValues; diff: Partial<ServerSettingsValues> }`.
  - `interface ServerSettings { get(): ServerSettingsValues; update(patch: Partial<ServerSettingsValues>): ServerSettingsValues; on(event: 'change', listener: (c: ServerSettingsChange) => void): () => void }`.
  - `createServerSettings(db: DatabaseSync): ServerSettings` — uses `node:events`' `EventEmitter` privately; caches the parsed row and re-reads after writes only (DB writes go through `update`, single owner).
  - `bootstrapFromEnv(db, env: NodeJS.ProcessEnv = process.env, now = Date.now): void` — atomic: reads row, if `seeded_from_env=0`, parses each `HORIZON_*` env (using local helpers `envInt`, `envBool` — copied from `config.ts` shape; non-empty raw string == "set"), composes the patch, runs a single `UPDATE server_settings SET ... seeded_from_env = 1, updated_at = ? WHERE id = 1` in one statement. If `seeded_from_env=1`, no-op (returns immediately).
  - Internal: a `SETTINGS_REGISTRY` constant that lists each setting's column, env var name, parser, and TypeScript type. Driven from this registry: zod schema, `bootstrapFromEnv`, the `UPDATE` SQL fragments. Single source of truth.

- `apps/server/src/repos/progress.ts` — change `ProgressRepoOpts.watchedThresholdPct: number` → `getWatchedThresholdPct: () => number`. In `setProgress`, read it at call time: `const threshold = opts.getWatchedThresholdPct()`. No other change.

- `apps/server/src/index.ts` — after `migrate(db)` and before constructing repos, create the settings store and run bootstrap:
  ```ts
  const serverSettings = createServerSettings(db)
  bootstrapFromEnv(db)
  ```
  Then refresh the cached snapshot (`serverSettings.get()` re-reads after bootstrap mutates the row out-of-band — see "Risks"). Replace `watchedThresholdPct: cfg.watchedThresholdPct` in the `createProgressRepo` call with `getWatchedThresholdPct: () => serverSettings.get().watchedThresholdPct`. Leave `Config.watchedThresholdPct` in `loadConfig()` untouched (still populated; just no longer read by production code — removal is a follow-up so this PR's blast radius stays bounded).

- `apps/server/test/db.migrate.test.ts` — extend existing suite with three cases: (a) `PRAGMA user_version` is `4` after fresh migrate, (b) `server_settings` table has the documented columns + the `CHECK (id = 1)` constraint rejects a second-row insert, (c) the row exists with the hardcoded defaults and `seeded_from_env = 0`.

- `apps/server/test/serverSettings.test.ts` — **new**. See "Tests" below for the exhaustive case list.

- `apps/server/test/repos.progress.test.ts` — single-line setup tweak: `createProgressRepo(db, media, { watchedThresholdPct: 90 })` → `createProgressRepo(db, media, { getWatchedThresholdPct: () => 90 })`. The rest of the file is unchanged (semantics identical for tests that don't mutate the threshold).

- `apps/server/test/routes.progress.test.ts` — same single-line setup tweak.

- `apps/server/test/ws.progress.test.ts` — same single-line setup tweak (two occurrences in the file, lines 31 and 60).

- `CONTEXT.md` — under a new top-level `## Configuration` section (placed between `## Identity` and `## Library`), add a `### ServerSettings` entry: explains the singleton row + env-overlay-once invariant, why the row is keyed `id=1` not k/v, the `seeded_from_env` semantic, and the fact that consumers should call `serverSettings.get()` rather than `loadConfig()` for live settings. Cross-link `apps/server/src/serverSettings.ts`.

### Schema (server_settings columns)

Decided from the existing `Config` knobs by isolating those that are operator-tunable at runtime (i.e., not deployment-shaped like `port` / `dbPath` / `cacheDir` / `corsOrigins` / `devSeedEnabled`, and not secrets like `tmdbToken`). The nested `toneMap` block and `forceEncoder` are explicitly **deferred** to a later slice — see "Out of scope".

**Library (4):** `scan_concurrency` INTEGER (4), `scan_cron_hour` INTEGER (3), `watch_fs` INTEGER (0), `watch_debounce_ms` INTEGER (5000).

**Metadata (4):** `metadata_batch_size` INTEGER (50), `metadata_max_age_movie_days` INTEGER (30), `metadata_max_age_show_days` INTEGER (7), `metadata_max_age_episode_days` INTEGER (60). (Days, not ms — env var is in days; less lossy across get/update round-trips.)

**Playback (5):** `watched_threshold_pct` INTEGER (90), `max_sessions` INTEGER (4), `ws_grace_ms` INTEGER (10000), `ws_attach_ms` INTEGER (10000), `max_renditions` INTEGER (3).

Per-column types are SQLite INTEGER throughout (booleans stored as 0/1 — matches existing `watch_progress.watched` convention). Numeric ranges (e.g., `scan_cron_hour` 0–23) are *not* enforced via SQL CHECK in this slice — bootstrap parsing and (future) the route layer own validation. Note this in Risks.

## Out of scope

- **Writing the ADR `docs/adr/0002-server-settings-singleton-with-env-overlay.md`.** Referenced in the issue body but not in the AC. The migration's comment cross-links the path so reviewers know where to look; creating the ADR is a follow-up (and the `docs/adr/` directory itself does not yet exist).
- **HTTP routes** for reading/writing settings. Issue body explicitly says "No HTTP routes and no UI in this slice."
- **Web/TV UI** for settings.
- **Migrating the rest of `Config` into `server_settings`.** `forceEncoder`, the nested `toneMap` block (operator + param + desat + peak + postCorrection), `moviesRoots`, `showsRoots`, `corsOrigins`, `tmdbToken`, `port`, `dbPath`, `cacheDir`, `devSeedEnabled` all stay in `Config`/env. Future slices move the operator-tunable ones; deployment-shaped + secret knobs stay in env permanently.
- **Removing `Config.watchedThresholdPct`.** The field stays — `loadConfig()` still parses it — to keep the diff bounded and the `baseCfg(...)` helper in `session.playback.test.ts` unbroken. The production code path no longer reads it (only the new `serverSettings.get()`). Cleanup is a one-line follow-up.
- **Converting other passive consumers** beyond `watchedThresholdPct`. AC asks for *at least one*. Doing more (e.g., `maxSessions` into `SessionManager`, `wsGraceMs` into the WS layer) would cascade test setup changes and inflate scope past the hard cap.
- **Per-column env-overlay on future migrations** that add more settings columns. The flag is row-level; new columns added in v5+ will use their hardcoded defaults regardless of env. Documented in Risks; mitigation is a future-migration convention, not a code change today.
- **Hot-reload semantics for other live consumers.** Once the read path is proven for `watchedThresholdPct`, the same thunk pattern (or direct `serverSettings.get()`) generalizes — but extending it is deferred.
- **Schema validation via SQL CHECK constraints** on individual columns (e.g., `scan_cron_hour BETWEEN 0 AND 23`). Bootstrap parser owns range validation today; route-layer Zod will own it later.

## Steps

1. **Test-first.** Write the new `apps/server/test/serverSettings.test.ts` (cases listed in "Tests" below). Run `npm -w @horizon/server run test -- serverSettings` — confirm red because the module doesn't exist yet.
2. Extend `apps/server/test/db.migrate.test.ts` with the three v4-shape cases. Run migrate tests — confirm red.
3. Implement `V4_SQL` in `apps/server/src/db/migrations.ts` and append `{ version: 4, sql: V4_SQL }` to `MIGRATIONS`. Run `npm -w @horizon/server run test -- db.migrate` — green.
4. Implement `apps/server/src/serverSettings.ts`:
   - Define `SETTINGS_REGISTRY` (one entry per column: `column`, `envVar`, `kind: 'int'|'bool'`, `default`). 13 entries.
   - Derive a zod schema from the registry for parsing the SELECT result. Use the existing `intBool` pattern from `db/rowSchemas.ts` (do not import — keep the module self-contained; copy the one-liner).
   - `createServerSettings(db)`:
     - Prepare a `SELECT ... FROM server_settings WHERE id = 1` statement; cache.
     - Internal cache: `let cached: ServerSettingsValues | null = null`. `get()` returns it (lazy initialise on first call).
     - `update(patch)`: validate every patch key is a known column (throw on stray keys), build a single `UPDATE server_settings SET <col1> = ?, ..., updated_at = ? WHERE id = 1` from the patch keys, run it, re-read the row, compute `diff` between prev cache and new, emit `change`, return the new value.
     - `on('change', fn)`: returns an unsubscribe thunk.
   - `bootstrapFromEnv(db, env = process.env, now = Date.now)`:
     - Open one statement: `SELECT seeded_from_env FROM server_settings WHERE id = 1`.
     - If `seeded_from_env = 1`, return immediately.
     - Else: for each entry in `SETTINGS_REGISTRY`, read `env[entry.envVar]`; if the raw value is a non-empty string, parse it (`parseInt` for `'int'` with NaN/negative guard mirroring `config.ts:envInt`; `'1' | 'true' | 'yes'` truthy for `'bool'`) and stage the value. Compose one `UPDATE server_settings SET <staged cols> = ..., seeded_from_env = 1, updated_at = ? WHERE id = 1`. Even when nothing was staged from env, still flip `seeded_from_env = 1` so subsequent boots no-op.
5. Run `serverSettings.test.ts` — green.
6. Update `apps/server/src/repos/progress.ts`:
   - Change `ProgressRepoOpts.watchedThresholdPct: number` → `getWatchedThresholdPct: () => number`.
   - In `setProgress`, change `opts.watchedThresholdPct` → `opts.getWatchedThresholdPct()`.
   - Type-only change otherwise.
7. Update the three progress test files (`repos.progress.test.ts`, `routes.progress.test.ts`, `ws.progress.test.ts`) — one-line setup tweak per file (`{ watchedThresholdPct: 90 }` → `{ getWatchedThresholdPct: () => 90 }`).
8. Update `apps/server/src/index.ts`:
   - Import `createServerSettings`, `bootstrapFromEnv` from `./serverSettings.ts`.
   - After `migrate(db)`: `bootstrapFromEnv(db); const serverSettings = createServerSettings(db)`. Bootstrap **before** the factory so the factory's first cache read sees the bootstrapped row.
   - In the `createProgressRepo(db, mediaRepo, { ... })` call, replace `watchedThresholdPct: cfg.watchedThresholdPct` with `getWatchedThresholdPct: () => serverSettings.get().watchedThresholdPct`.
9. Run `npm -w @horizon/server run test` — full suite green.
10. Update `CONTEXT.md` with the `### ServerSettings` entry under a new `## Configuration` section.
11. Run verification commands (see below). Commit.

## Tests

**Test-first: yes.** Failing tests before any production change:

### `apps/server/test/db.migrate.test.ts` (extend existing)
1. After `migrate(:memory:)`, `PRAGMA user_version === 4`.
2. `PRAGMA table_info(server_settings)` returns the documented column set (13 settings cols + `id`, `seeded_from_env`, `updated_at`).
3. `INSERT INTO server_settings (id, ...) VALUES (2, ...)` throws (CHECK constraint).
4. After migrate on a fresh DB, exactly one row exists with `id=1`, `seeded_from_env=0`, and `watched_threshold_pct=90` (smoke-test that defaults match the registry).

### `apps/server/test/serverSettings.test.ts` (new)
1. **Fresh-install bootstrap (no envs set):** open `:memory:` DB, `migrate`, call `bootstrapFromEnv(db, {})`. Then read the row directly: `seeded_from_env=1`, all setting columns equal their hardcoded defaults.
2. **Upgrade bootstrap (envs override defaults):** open DB, migrate, call `bootstrapFromEnv(db, { HORIZON_WATCHED_THRESHOLD_PCT: '75', HORIZON_MAX_SESSIONS: '8', HORIZON_WATCH_FS: '1', HORIZON_METADATA_MAX_AGE_MOVIE_DAYS: '14' })`. Read row: `watched_threshold_pct=75`, `max_sessions=8`, `watch_fs=1`, `metadata_max_age_movie_days=14`, others at default, `seeded_from_env=1`.
3. **Second boot ignores env even if changed:** after test #2, call `bootstrapFromEnv(db, { HORIZON_WATCHED_THRESHOLD_PCT: '50' })`. Row's `watched_threshold_pct` is still 75 — no-op since flag is already 1.
4. **Invalid env values fall back to default:** `bootstrapFromEnv(db, { HORIZON_WATCHED_THRESHOLD_PCT: 'banana' })` on fresh DB — row's `watched_threshold_pct` is 90 (the default) and flag is 1.
5. **Empty env string is treated as unset:** `HORIZON_WATCHED_THRESHOLD_PCT=''` → default applied; matches `config.ts:envInt`.
6. **`get()` returns typed live row:** call after bootstrap, assert shape (numbers are numbers; booleans are booleans).
7. **`update(patch)` writes back:** create `serverSettings`, call `update({ watchedThresholdPct: 60 })`, then `get().watchedThresholdPct === 60`. Direct DB SELECT confirms persistence.
8. **`update` emits typed `change` event with diff:** register `on('change', spy)`, call `update({ watchedThresholdPct: 60, maxSessions: 2 })`, assert spy was called once with `{ prev, next, diff: { watchedThresholdPct: 60, maxSessions: 2 } }` (where `diff` omits keys unchanged).
9. **`update` rejects unknown keys:** `update({ notAColumn: 1 } as any)` throws.
10. **`on('change')` returns an unsubscribe thunk:** call thunk, then `update(...)`; spy not invoked.
11. **Passive consumer sees new values:** wire `getWatchedThresholdPct: () => serverSettings.get().watchedThresholdPct` into `createProgressRepo`, set progress at 80% then `update({ watchedThresholdPct: 70 })`, set progress *again* at 80% on the same media; the second `setProgress` returns `watched=true` (threshold dropped) while the first returned `watched=false`. Tests live end-to-end read path.

### Existing tests checked
- `repos.progress.test.ts`, `routes.progress.test.ts`, `ws.progress.test.ts` — each `createProgressRepo(..., { watchedThresholdPct: 90 })` becomes `({ getWatchedThresholdPct: () => 90 })`. Assertions unchanged.
- `config.test.ts` — untouched; `Config.watchedThresholdPct` still populated by `loadConfig()`.
- `session.playback.test.ts` `baseCfg` helper — untouched; the field is still on `Config`.

## Verification commands
- `npm -w @horizon/server run typecheck`
- `npm -w @horizon/server run test`
- `npm test` *(root — runs server + sdk vitest)*
- `npm -w @horizon/sdk run build` *(no `typecheck` script; `build` runs `tsc`)*
- `npm -w @horizon/web run build` *(catches any incidental type breakage from the SDK)*

## Risks / open questions

- **Bootstrap ordering vs the cached `serverSettings.get()`.** `bootstrapFromEnv` mutates the row directly via SQL (not through `update()`), so the cache inside `createServerSettings` could end up stale if we constructed the store *before* bootstrap. Mitigation: call `bootstrapFromEnv(db)` **first**, then `createServerSettings(db)` — the factory's lazy cache reads the post-bootstrap row on first `get()`. Steps 4 and 8 spell this out.
- **Future schema additions don't get env-overlay.** Once `seeded_from_env=1` flips, any v5+ migration that adds a column gets only the hardcoded default — no `HORIZON_*` overlay. This is a real gap (an operator who sets `HORIZON_NEW_KNOB=...` between upgrades won't see it picked up). Documented out-of-scope for this slice; mitigation is a per-migration convention (a future migration that adds a column should run its own targeted env-overlay for that column's env var). Flag in CONTEXT.md.
- **Hot-reload of in-flight settings.** `progressRepo.setProgress` re-reads the threshold every call via the thunk — cheap (`get()` returns a cached object). Other potential consumers (e.g., session limits, WS grace) would need similar plumbing; not in this slice.
- **Concurrent `update()` callers.** The module emits a `change` event synchronously after the SQL `UPDATE`. There's no transactional guard against two callers interleaving (no routes yet, so only test code can hit this); cache is re-read after every write so eventual consistency is preserved. Add a real lock when an HTTP write route lands.
- **Type contract for `update(patch)`.** Patch is `Partial<ServerSettingsValues>`. Implementation rejects keys not in the registry (cast-and-pass would silently no-op otherwise). Test #9 covers this.
- **`watched_threshold_pct` stored as integer percent (not float).** Matches the existing env var (`HORIZON_WATCHED_THRESHOLD_PCT=90` → int). Implementation should NOT divide on the way in/out; the divide-by-100 happens in `computeWatched` as today.
- **Days vs ms in metadata-max-age columns.** Stored as **days** (the env-var unit), not ms (the `Config` runtime unit). Conversion to ms happens at the consumer when/if those settings are wired into `MetadataRefreshWorker` in a later slice. Note this in the column comment + CONTEXT.md so a future consumer doesn't accidentally pass `metadataMaxAgeMovieDays * 1` into a `* ms` API.
- **No SQL `CHECK` constraints on column ranges.** A future operator-write via the (yet-to-build) PATCH /settings route could insert `watched_threshold_pct = 9001` without DB pushback. Bootstrap parser doesn't see it (only env). Add Zod range checks at the route layer when it lands; document the gap in CONTEXT.md.
- **The ADR referenced in the issue (`docs/adr/0002-...`) does not exist in this repo.** Out of scope to author (AC doesn't ask for it). Migration comment + CONTEXT.md cross-link the planned path so it's not a dangling reference for long.
- **Test isolation: env mutation across tests.** `serverSettings.test.ts` passes the env explicitly to `bootstrapFromEnv(db, envObject)` rather than mutating `process.env`. Cleaner than the existing `beforeEach` `delete process.env.*` pattern in `config.test.ts` — fewer cross-test contamination footguns.
