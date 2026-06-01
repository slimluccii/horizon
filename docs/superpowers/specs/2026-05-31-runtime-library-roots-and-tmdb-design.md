# Runtime-configurable library roots + TMDB token

**Date:** 2026-05-31
**Status:** Approved (pending spec review)

## Problem

Media library roots (`HORIZON_MOVIES_ROOT` / `HORIZON_SHOWS_ROOT`) and the TMDB
token (`HORIZON_TMDB_TOKEN`) are configured only via environment variables. The
operator must edit env + restart to change what the server indexes. We want both
to be configurable from the web UI — during first-run setup and later from
Settings — like Plex/Jellyfin.

The TMDB token is **already** a runtime server setting (DB-stored, env-seeded,
hot-swaps the TMDB client on change, masked in the API). So that half is mostly
UI surfacing. Library roots are env-only and read by the scan manager from
`Config`; making them runtime-settable is the substantive work.

## Goals

- Library roots stored in the DB, settable via the web UI (setup + Settings).
- Roots confined to one or more operator-defined base directories — a household
  user must not be able to point the server at arbitrary filesystem paths.
- Multiple roots per kind, across multiple base dirs / mounts.
- TMDB token collected during setup and changeable in Settings.
- Remove the `HORIZON_MOVIES_ROOT` / `HORIZON_SHOWS_ROOT` env vars.

## Non-goals

- No general filesystem browser — only directories under the configured bases.
- No per-user libraries / permissions. Roots are household-wide (owner/admin manage).
- No change to playback, transcode, or metadata internals beyond reacting to
  root/token changes.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Path selection | Confined server-side **folder browser**; owner tags each folder Movies/Shows |
| Confinement | Allowlisted **base dirs** (`HORIZON_MEDIA_BASE`, colon-separated list); a root is valid if under ANY base |
| Old root env vars | **Removed entirely**; roots live only in settings |
| Setup wizard | Multi-step, **all steps skippable**; skipping folders → empty library + banner |
| Folder removal | **Prune its media on rescan** + immediate prune-under-prefix + clean orphaned watch-progress |
| Media mount | Stays read-only (`:ro`) |
| TMDB token display | Keep `set`/`unset` masking; value never returned to the browser |

## Architecture

### Config (`apps/server/src/config.ts`)
- **Add** `mediaBases: string[]` from `HORIZON_MEDIA_BASE` (colon-separated,
  default `['/media']`), each resolved to an absolute path.
- **Remove** `moviesRoots`, `showsRoots` from `Config` and `loadConfig`.
- Remove `HORIZON_MOVIES_ROOT` / `HORIZON_SHOWS_ROOT` parsing.

### Settings store (`apps/server/src/repos/serverSettings.ts`)
- New migration: add `movies_roots TEXT NOT NULL DEFAULT '[]'`,
  `shows_roots TEXT NOT NULL DEFAULT '[]'` to `server_settings` (JSON arrays).
- `ServerSettingsRow` gains `moviesRoots: string[]`, `showsRoots: string[]`
  (parse/serialize JSON in `rowToSettings` / `update`).
- `ServerSettingsPatch` gains both arrays.
- `bootstrapFromEnv`: no longer seeds roots (env roots removed). Token seeding
  unchanged. Roots default to `[]` on a fresh DB.

### Confinement helper (`apps/server/src/paths/confine.ts`) — security boundary
- Pure module, the single source of truth for "is this path allowed".
- `resolveUnderBases(bases: string[], candidate: string): string | null`
  - `path.resolve` the candidate; reject `..` escapes.
  - `fs.realpathSync` both candidate and bases to defeat symlink escape.
  - Return the resolved real path iff it equals or is under one of the bases;
    else `null`.
- Used by BOTH the browse endpoint and the settings roots validator.
- Heavily unit-tested: traversal (`/media/../etc`), symlink escape, base
  equality, sibling-prefix (`/media-evil` must not pass for base `/media`),
  non-existent path.

### Directory browser (`apps/server/src/routes/library.ts`)
- `GET /library/browse?path=<abs>` — owner/admin only (members 403).
- No `path` (or empty) → return the configured bases as the top-level entries.
- With `path` → `resolveUnderBases`; on `null` return 400 `INVALID_PATH`.
  Otherwise list **immediate subdirectories** only (dirs, never files):
  `{ entries: Array<{ name: string; path: string }>, parent: string | null }`.
- `parent` is the path's parent if still under a base, else `null` (can't browse
  above a base).

### Roots settings API (`apps/server/src/routes/settings.ts`)
- `PatchBody` gains `moviesRoots?: string[]`, `showsRoots?: string[]`
  (`z.array(z.string())`). On PATCH, every entry is validated with
  `resolveUnderBases`; any entry outside the bases or non-existent → 400
  `INVALID_PATH` (no partial write). Stored as the resolved absolute paths.
- `GET /settings/server` returns `moviesRoots` / `showsRoots` (not secret —
  already-mounted, operator-visible paths).
- Existing owner/admin gate on PATCH unchanged.

### Live consumption + change reactions
- `createScanManager` takes a `getRoots(): { movies: string[]; shows: string[] }`
  thunk reading `serverSettings`, replacing static `cfg.moviesRoots/showsRoots`
  (matches the existing ServerSettings-thunk pattern). Full-scope scans and
  per-root bookkeeping read live roots.
- `index.ts` FS watcher reads roots live; its root set = `[...movies, ...shows]`.
- On `server_settings` `change` where `moviesRoots`/`showsRoots` changed
  (handled in `index.ts`, alongside existing tmdbToken/scanCronHour/watchFs handlers):
  - Compute added/removed sets vs the previous value.
  - **Added** → `scanManager.request({ trigger: 'manual', paths: [...added] })`.
  - **Removed** → for each, `mediaRepo.softDeleteMissingUnder(removedRoot, ∅)`
    (immediate prune of everything under it), then clean orphaned watch-progress
    rows for the soft-deleted media.
  - Restart the FS watcher with the new root set (reuse existing restart path).
- Empty roots is valid: no scan, empty library.

### Watch-progress cleanup
- Add `progressRepo.deleteForMissingMedia()` (or reuse existing sweep if present)
  that removes progress rows whose `mediaId` references a soft-deleted/absent
  media row. Called after a root-removal prune. (Confirm whether a sweep already
  exists during implementation; if so, reuse it.)

### SDK (`libs/sdk`)
- `ServerSettings` type gains `moviesRoots: string[]`, `showsRoots: string[]`.
- `horizon.library.browse(path?: string)` → `{ entries, parent }`.
- `horizon.settings.update({ moviesRoots, showsRoots, tmdbToken })` already exists
  for the token; extend types for the arrays.

### Web UI (`apps/web`)
- **Folder browser component** (`components/FolderBrowser`): calls
  `library.browse`, shows base list → drill into subdirs → "Add as Movies / Add
  as Shows". Breadcrumb; can't navigate above a base.
- **Setup wizard** (`pages/Setup.tsx`): multi-step, all skippable —
  ① create owner ② add library folders (browser) ③ TMDB token (optional)
  ④ finish + kick initial scan. Skipping folders lands in an empty library.
- **Empty-library banner** (`pages/Library.tsx`): when no roots configured, show
  "Add library folders → Settings" CTA (owner/admin).
- **Settings → Server tab** (`pages/Settings.tsx`): "Library folders" section
  (list current Movies/Shows roots, add via browser, remove with confirm noting
  its items will be removed on rescan), and a **TMDB token** field (shows
  `set`/`unset`, replace/clear; never displays the value).

## Docker / docs
- `docker-compose.yml`: replace the `…/movies` + `…/shows` mounts with one (or
  more) base mounts, e.g. `${HORIZON_MEDIA_HOST}:/media:ro`; set
  `HORIZON_MEDIA_BASE=/media`. Document multiple bases (`/media:/media2`).
- `.env.example`: drop `HORIZON_MOVIES_ROOT`/`HORIZON_SHOWS_ROOT`; add
  `HORIZON_MEDIA_HOST` + `HORIZON_MEDIA_BASE`.
- `docs/DEPLOY.md`: mount the media tree under a base, pick folders in the UI on
  first run; multiple-base example.

## Security

- The confinement helper (`resolveUnderBases`) is the single gate; both the
  browser and the settings validator go through it. Symlink + `..` escape
  defeated via `realpath`.
- Browse + roots-PATCH are owner/admin only. Members cannot enumerate the
  filesystem or change roots.
- Media mounts remain read-only.
- The bases are operator-controlled (env), so even the owner can only reach what
  the operator mounted — preserving the trusted-LAN posture while removing the
  arbitrary-path footgun.

## Testing

- `confine.ts`: unit tests for traversal, symlink escape, base equality,
  sibling-prefix rejection, non-existent path, multiple bases.
- `GET /library/browse`: role gate (member 403), base listing with no path,
  subdir listing, confinement rejection (400), dirs-only, no-escape-above-base.
- `PATCH /settings/server`: roots accepted under a base, rejected outside / when
  missing (400, no partial write), persisted + round-tripped via GET.
- Scan manager: reads live roots via thunk; added-root triggers scan;
  removed-root prunes under prefix.
- Root-removal: progress rows for pruned media cleaned up.
- Update existing Config test fixtures for removed `moviesRoots/showsRoots` +
  added `mediaBases`. Keep all current tests green.

## Migration / compatibility

- DB migration adds the two columns defaulting to `[]`. Existing installs come up
  with no roots → empty library + banner; owner re-adds folders once in the UI
  (acceptable, per decision to remove the env vars).
- `HORIZON_TMDB_TOKEN` env seeding unchanged.
