# TV Scanner Fix + Inline Movie Collections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the TV scanner so nested show folders are detected correctly (no more single "Tv" item), and group movie franchises into TMDB-derived collections shown inline in the Movies grid behind a per-user toggle, with a collection detail page.

**Architecture:** Server scanner detects shows by walking to each episode file and inferring its show directory (Plex/Jellyfin style), removing the fixed-depth assumption. Movie collections come from TMDB `belongs_to_collection`, stored in the `collections` table, exposed via existing endpoints, and merged into the Movies grid client-side based on a per-user preference. A new `/collection/:id` page mirrors the show detail page.

**Tech Stack:** TypeScript, Node, Fastify, better-sqlite3, Vitest, React + react-router, Zod, TMDB API.

---

## File Structure

**Part A — scanner**
- Modify: `apps/server/src/scanner/scanner.ts` — content-based show detection.
- Modify: `apps/server/src/scanner/manager.ts` — normalize roots in `liveCfg`.
- Test: `apps/server/test/scanner.integration.test.ts` — nested fixtures.

**Part B — collections**
- Modify: `apps/server/src/metadata/types.ts`, `libs/sdk/src/types.ts` — `MovieMetadata.collection`.
- Modify: `apps/server/src/metadata/tmdb.ts` — map `belongs_to_collection`.
- Modify: `apps/server/src/db/migrations.ts` — collection columns in baseline.
- Modify: `apps/server/src/repos/collections.ts` — carry tmdbId/poster/backdrop.
- Replace: `apps/server/src/scanner/collections.ts` — TMDB grouping (was title heuristic).
- Replace: `apps/server/test/collections.test.ts` — test new grouping.
- Modify: `apps/server/src/routes/library.ts` — return new collection fields.
- Modify: `libs/sdk/src/client.ts` — `getCollection`, richer `listCollections`.
- Create: `libs/sdk/src/collections.ts` — `mergeMoviesAndCollections` + `CollectionSummary`.
- Create: `libs/sdk/test/collections.test.ts` — merge helper unit test.
- Modify: `libs/sdk/src/preferences.ts` — `collapseMovieCollections`.
- Modify: `apps/web/src/pages/Settings.tsx` — toggle.
- Create: `apps/web/src/components/CollectionPoster.tsx` — collection card.
- Modify: `apps/web/src/pages/Library.tsx` — remove Collections tab, inline merge.
- Create: `apps/web/src/pages/Collection.tsx` — detail page.
- Modify: `apps/web/src/App.tsx` — `/collection/:id` route.

---

## Part A — Scanner fix

### Task 1: Content-based show detection

**Files:**
- Modify: `apps/server/src/scanner/scanner.ts:155-231` (`scanShowsPath`) + helpers near line 67.
- Test: `apps/server/test/scanner.integration.test.ts`

- [ ] **Step 1: Read the existing integration test to match its fixture style**

Run: `sed -n '1,80p' apps/server/test/scanner.integration.test.ts`
Note how it creates temp dirs and calls `runScan(fullScope(cfg), cfg, deps)`. Reuse that harness for the new test.

- [ ] **Step 2: Write the failing test**

Add to `apps/server/test/scanner.integration.test.ts` (inside the existing `describe`, adapt `mkScanEnv`/temp-dir helper names to whatever the file already defines):

```ts
it('detects shows nested below a category folder, not the wrapper', async () => {
  // root/anime/Frieren/Season 01/S01E01.mkv  +  root/Breaking Bad/S01E01.mkv
  const root = await mkdtemp(join(tmpdir(), 'hz-shows-'))
  await mkdir(join(root, 'anime', 'Frieren', 'Season 01'), { recursive: true })
  await mkdir(join(root, 'Breaking Bad'), { recursive: true })
  await writeFile(join(root, 'anime', 'Frieren', 'Season 01', 'S01E01.mkv'), 'x')
  await writeFile(join(root, 'Breaking Bad', 'S01E02.mkv'), 'x')

  const { media, collections } = makeRepos() // existing helper in this file
  const cfg = { showsRoots: [root], moviesRoots: [], cacheDir: root, scanConcurrency: 2 }
  await runScan(fullScope(cfg), cfg, { media, collections })

  const shows = media.listShows()
  const titles = shows.map(s => s.title).sort()
  expect(titles).toEqual(['Breaking Bad', 'Frieren'])
  expect(titles).not.toContain('anime')
})
```

If `probe` requires real video, the existing integration test already mocks/stubs it — follow the same mock so `.mkv` stubs probe successfully. If the file stubs probe via `vi.mock`, ensure this test is under that mock.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm -w @horizon/server exec vitest run test/scanner.integration.test.ts`
Expected: FAIL — current code creates a single show "anime" (or similar), titles don't match.

- [ ] **Step 4: Add the season-folder regex + show-dir helper**

In `apps/server/src/scanner/scanner.ts`, after `episodeTitle` (around line 75), add:

```ts
/** Season-folder names to skip when inferring a show directory:
 *  "Season 01", "Season 1", "Series 1", "Specials", "S01", "S1". */
const SEASON_DIR_RE = /^(?:season|series|specials)\b|^s\d{1,2}$/i

/** Infer the show directory for an episode file. The show is the file's parent
 *  unless that parent is a season folder, in which case it's the grandparent.
 *  This is independent of how deep the show sits below the library root, so
 *  category/wrapper folders (tv/, anime/, A-D/) never become shows. */
function showDirForEpisode(file: string): string {
  const parent = path.dirname(file)
  if (SEASON_DIR_RE.test(path.basename(parent))) return path.dirname(parent)
  return parent
}
```

- [ ] **Step 5: Rewrite `scanShowsPath` to group by inferred show dir**

Replace the body of `scanShowsPath` (lines 155-231) with:

```ts
async function scanShowsPath(
  pathToScan: string,
  cfg: ScanConfig,
  media: MediaRepo,
  progress: ScanProgressReporter,
): Promise<{ seen: Set<string>; added: number; failed: number }> {
  const seen = new Set<string>()
  let added = 0
  let failed = 0

  // Walk every episode file under the path, then group by inferred show dir.
  // No fixed-depth assumption: works whether pathToScan is a library root, a
  // category folder, or a single show directory, and for arbitrary nesting.
  const roots = new Set(cfg.showsRoots ?? [])
  const { files } = await walkVideoFiles(pathToScan).catch(() => ({ files: [], dirsSeen: 0 }))

  type EpCand = { file: string; base: string; em: RegExpExecArray; showDir: string }
  const epCands: EpCand[] = []
  for (const file of files) {
    const base = path.basename(file)
    const em = EPISODE_RE.exec(base)
    if (!em) continue
    const showDir = showDirForEpisode(file)
    // A loose episode sitting directly in a configured root has no real show
    // folder — skip it rather than naming a show after the root.
    if (roots.has(showDir)) { failed++; continue }
    epCands.push({ file, base, em, showDir })
  }
  progress.addTotal(epCands.length)

  // Upsert one show per distinct showDir before its episodes.
  const showIdByDir = new Map<string, string>()
  for (const { showDir } of epCands) {
    if (showIdByDir.has(showDir)) continue
    const showName = path.basename(showDir)
    const showId = hashId(showDir)
    showIdByDir.set(showDir, showId)
    const existedShow = media.getById(showId) !== null
    media.upsertShow({
      id: showId,
      title: cleanTitle(showName),
      sortYear: null,
      externalIds: parseIds(showName),
      metadata: null,
    })
    seen.add(showId)
    if (!existedShow) added++
  }

  await pMap(epCands, cfg.scanConcurrency, async ({ file, base, em, showDir }) => {
    const showId = showIdByDir.get(showDir)!
    const showName = path.basename(showDir)
    const p = await probe(file, cfg.cacheDir).catch(() => null)
    if (!p) { failed++; progress.tick(); return }
    const st = await stat(file).catch(() => null)
    if (!st) { failed++; progress.tick(); return }
    const id = hashId(file)
    const existed = media.getById(id) !== null
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
      externalIds: mergeIds(parseIds(showName), parseIds(base)),
      metadata: null,
    }
    media.upsertEpisode(insert)
    seen.add(id)
    if (!existed) added++
    progress.tick()
  })

  return { seen, added, failed }
}
```

The `readdir` import at line 1 may now be unused — if so, change `import { readdir, stat }` to `import { stat }`. Verify with the typecheck in Step 7.

- [ ] **Step 6: Run the new test to verify it passes**

Run: `npm -w @horizon/server exec vitest run test/scanner.integration.test.ts`
Expected: PASS, including the existing tests in that file (flat shows still work — a flat `root/Show/ep` layout infers `showDir = root/Show`).

- [ ] **Step 7: Typecheck + full server test run**

Run: `npm -w @horizon/server run build` (or the repo's typecheck script) then `npm -w @horizon/server run test`
Expected: no type errors; all scanner tests pass. Fix the unused `readdir` import if flagged.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/scanner/scanner.ts apps/server/test/scanner.integration.test.ts
git commit -m "fix(scanner): detect shows by episode location, not folder depth"
```

### Task 2: Normalize library roots in the scan manager

**Files:**
- Modify: `apps/server/src/scanner/manager.ts:72-75` (`liveCfg`)
- Test: `apps/server/test/scanner.manager.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/server/test/scanner.manager.test.ts`:

```ts
it('normalizes roots so a trailing-slash root still matches subtree scans', async () => {
  const captured: string[] = []
  const mgr = createScanManager(
    { cacheDir: '/tmp', scanConcurrency: 1 },
    {
      ...baseDeps, // existing helper providing media/collections/scanRoots/scanHistory
      getRoots: () => ({ movies: [], shows: ['/media/tv/'] }),
      // stub runScan path capture via a media spy, OR assert classifyPath result:
    },
  )
  // classifyPath is exported; assert the normalized root matches a subtree path.
  expect(classifyPath('/media/tv/Show', { showsRoots: ['/media/tv'], moviesRoots: [] }))
    .toBe('shows')
})
```

If the manager test file has no easy hook to observe `liveCfg`, prefer a direct unit assertion on `classifyPath` (exported from `scanner.ts`) plus a small manager test that a request with path `/media/tv/Show` is classified to `showsPaths` when the configured root is `/media/tv/`. Use whatever observation the existing tests already use (they spy on `deps.media`/`runScan`).

- [ ] **Step 2: Run to verify it fails**

Run: `npm -w @horizon/server exec vitest run test/scanner.manager.test.ts`
Expected: FAIL — `/media/tv/` (trailing slash) doesn't match `/media/tv/Show` via `startsWith('/media/tv//')`.

- [ ] **Step 3: Normalize roots in `liveCfg`**

In `apps/server/src/scanner/manager.ts`, replace `liveCfg` (lines 72-75):

```ts
  function liveCfg(): ScanConfig {
    const { movies, shows } = deps.getRoots()
    const norm = (r: string) => path.resolve(r).replace(/\/+$/, '')
    return { ...cfg, moviesRoots: movies.map(norm), showsRoots: shows.map(norm) }
  }
```

`path` is already imported at line 1.

- [ ] **Step 4: Run to verify it passes**

Run: `npm -w @horizon/server exec vitest run test/scanner.manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/scanner/manager.ts apps/server/test/scanner.manager.test.ts
git commit -m "fix(scanner): normalize library roots so subtree scans classify reliably"
```

---

## Part B — Movie collections

### Task 3: Add `collection` to MovieMetadata + map from TMDB

**Files:**
- Modify: `apps/server/src/metadata/types.ts` (`MovieMetadata`)
- Modify: `libs/sdk/src/types.ts` (`MovieMetadata`)
- Modify: `apps/server/src/metadata/tmdb.ts` (`TmdbMovie`, `mapMovie`)
- Test: `apps/server/test/metadata.tmdb.test.ts`

- [ ] **Step 1: Write the failing test**

Read `apps/server/test/metadata.tmdb.test.ts` first to match its fetch-mock style. Then add:

```ts
it('maps belongs_to_collection into MovieMetadata.collection', async () => {
  // Arrange the fetch mock to return a movie payload including:
  //   belongs_to_collection: { id: 1241, name: 'Harry Potter Collection',
  //     poster_path: '/p.jpg', backdrop_path: '/b.jpg' }
  const meta = await client.movieByTmdbId(671) // use the file's existing client setup
  expect(meta?.collection).toEqual({
    tmdbId: 1241,
    name: 'Harry Potter Collection',
    posterPath: '/p.jpg',
    backdropPath: '/b.jpg',
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm -w @horizon/server exec vitest run test/metadata.tmdb.test.ts`
Expected: FAIL — `collection` is undefined.

- [ ] **Step 3: Extend the `MovieMetadata` interface (server)**

In `apps/server/src/metadata/types.ts`, inside `MovieMetadata`, after `directors?: Person[]`:

```ts
  /** TMDB belongs_to_collection, when the film is part of a franchise. */
  collection?: {
    tmdbId: number
    name: string
    posterPath?: string | null
    backdropPath?: string | null
  }
```

- [ ] **Step 4: Mirror it in the SDK type**

In `libs/sdk/src/types.ts`, inside `MovieMetadata` (ends at line ~146), after `directors?: Person[]`, add the identical block:

```ts
  collection?: {
    tmdbId: number
    name: string
    posterPath?: string | null
    backdropPath?: string | null
  }
```

- [ ] **Step 5: Add the TMDB wire field + map it**

In `apps/server/src/metadata/tmdb.ts`, add to `interface TmdbMovie` (after `credits?: TmdbCredits`):

```ts
  belongs_to_collection?: {
    id: number
    name: string
    poster_path?: string | null
    backdrop_path?: string | null
  } | null
```

Then in `mapMovie`, before the `return {`, compute:

```ts
  const bc = m.belongs_to_collection
  const collection = bc
    ? { tmdbId: bc.id, name: bc.name, posterPath: bc.poster_path ?? null, backdropPath: bc.backdrop_path ?? null }
    : undefined
```

And add `collection,` to the returned object (alongside `directors`).

- [ ] **Step 6: Run to verify it passes**

Run: `npm -w @horizon/server exec vitest run test/metadata.tmdb.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/metadata/types.ts apps/server/src/metadata/tmdb.ts libs/sdk/src/types.ts apps/server/test/metadata.tmdb.test.ts
git commit -m "feat(metadata): capture TMDB belongs_to_collection on movies"
```

### Task 4: Collection table columns + repo fields

**Files:**
- Modify: `apps/server/src/db/migrations.ts` (V1_SQL `collections` table)
- Modify: `apps/server/src/repos/collections.ts`
- Test: `apps/server/test/repos.collections.test.ts`

- [ ] **Step 1: Write the failing test**

Read `apps/server/test/repos.collections.test.ts`. Add:

```ts
it('round-trips tmdbId, posterPath, backdropPath', () => {
  repo.replaceAll([
    { id: 'c1', name: 'Harry Potter Collection', tmdbId: 1241,
      posterPath: '/p.jpg', backdropPath: '/b.jpg', movieIds: ['m1', 'm2'] },
  ])
  const [c] = repo.list()
  expect(c).toMatchObject({
    id: 'c1', name: 'Harry Potter Collection', tmdbId: 1241,
    posterPath: '/p.jpg', backdropPath: '/b.jpg', movieIds: ['m1', 'm2'],
  })
})
```

The test's existing setup must insert `media_items` rows for `m1`/`m2` first if FK enforcement applies (the table `collection_items` references `media_items`). Follow how the file already seeds media rows.

- [ ] **Step 2: Run to verify it fails**

Run: `npm -w @horizon/server exec vitest run test/repos.collections.test.ts`
Expected: FAIL — `replaceAll` doesn't accept/persist the new fields; columns don't exist.

- [ ] **Step 3: Add columns to the baseline schema**

In `apps/server/src/db/migrations.ts`, replace the `collections` table definition in `V1_SQL`:

```sql
CREATE TABLE collections (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  tmdb_id      INTEGER,
  poster_path  TEXT,
  backdrop_path TEXT,
  updated_at   INTEGER NOT NULL
);
```

(Baseline edit is correct here — repo policy: v1 is unreleased, no deployed DBs to migrate. See the comment above `V1_SQL`.)

- [ ] **Step 4: Update the `Collection` interface + repo**

In `apps/server/src/repos/collections.ts`, change the interface:

```ts
export interface Collection {
  id: string
  name: string
  tmdbId: number | null
  posterPath: string | null
  backdropPath: string | null
  movieIds: string[]
}
```

Update `replaceAll`'s insert:

```ts
        const insCol = db.prepare(
          'INSERT INTO collections (id, name, tmdb_id, poster_path, backdrop_path, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        ...
        for (const c of collections) {
          insCol.run(c.id, c.name, c.tmdbId, c.posterPath, c.backdropPath, now)
          c.movieIds.forEach((mediaId, pos) => insItem.run(c.id, mediaId, pos))
        }
```

Update `list`'s select + mapping:

```ts
      const cols = db.prepare(
        'SELECT id, name, tmdb_id, poster_path, backdrop_path FROM collections ORDER BY name ASC',
      ).all() as { id: string; name: string; tmdb_id: number | null; poster_path: string | null; backdrop_path: string | null }[]
      ...
      return cols.map(c => ({
        id: c.id,
        name: c.name,
        tmdbId: c.tmdb_id,
        posterPath: c.poster_path,
        backdropPath: c.backdrop_path,
        movieIds: itemsByCollection.get(c.id) ?? [],
      }))
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm -w @horizon/server exec vitest run test/repos.collections.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/migrations.ts apps/server/src/repos/collections.ts apps/server/test/repos.collections.test.ts
git commit -m "feat(db): collections carry tmdbId, poster, backdrop"
```

### Task 5: Build collections from TMDB metadata

**Files:**
- Replace: `apps/server/src/scanner/collections.ts`
- Replace: `apps/server/test/collections.test.ts`
- Modify: `apps/server/src/scanner/scanner.ts` (`runScan`, lines 285-292)

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `apps/server/test/collections.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildCollections } from '../src/scanner/collections.ts'
import type { MediaItem } from '../src/repos/media.ts'

function movie(id: string, title: string, year: number, col?: { tmdbId: number; name: string; posterPath?: string; backdropPath?: string }): MediaItem {
  return {
    id, kind: 'movie', parentId: null, title, year, season: null, episode: null,
    durationSec: null, resolution: null, videoCodec: null, container: null, hdr: null,
    audioTracks: null, subtitleTracks: null, externalIds: {},
    metadata: col ? { kind: 'movie', title, collection: col } : { kind: 'movie', title },
  } as unknown as MediaItem
}

describe('buildCollections', () => {
  it('groups movies sharing a TMDB collection, sorted by year', () => {
    const hp = { tmdbId: 1241, name: 'Harry Potter Collection', posterPath: '/p.jpg', backdropPath: '/b.jpg' }
    const movies = [
      movie('b', 'Chamber of Secrets', 2002, hp),
      movie('a', "Philosopher's Stone", 2001, hp),
      movie('x', 'Inception', 2010),
    ]
    const cols = buildCollections(movies)
    expect(cols).toHaveLength(1)
    expect(cols[0]).toMatchObject({ name: 'Harry Potter Collection', tmdbId: 1241, posterPath: '/p.jpg', backdropPath: '/b.jpg' })
    expect(cols[0].movieIds).toEqual(['a', 'b']) // year-sorted
  })

  it('skips collections with fewer than 2 owned films', () => {
    const solo = { tmdbId: 99, name: 'Solo Collection' }
    expect(buildCollections([movie('a', 'Only One', 2000, solo)])).toHaveLength(0)
  })

  it('ignores movies without collection metadata', () => {
    expect(buildCollections([movie('a', 'A', 2000), movie('b', 'B', 2001)])).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm -w @horizon/server exec vitest run test/collections.test.ts`
Expected: FAIL — `buildCollections` does not exist (old file exports `detectCollections`).

- [ ] **Step 3: Replace `collections.ts` with TMDB grouping**

Replace the entire contents of `apps/server/src/scanner/collections.ts`:

```ts
import crypto from 'node:crypto'
import type { MediaItem } from '../repos/media.ts'
import type { MovieMetadata } from '../metadata/types.ts'

export interface BuiltCollection {
  id: string
  name: string
  tmdbId: number
  posterPath: string | null
  backdropPath: string | null
  movieIds: string[]
}

function hashId(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 16)
}

function movieMeta(m: MediaItem): MovieMetadata | null {
  return (m.metadata as MovieMetadata | undefined)?.kind === 'movie' ? (m.metadata as MovieMetadata) : null
}

/** Group owned movies into collections using TMDB `belongs_to_collection`.
 *  Only collections with 2+ owned films are kept; members are year-sorted. */
export function buildCollections(movies: MediaItem[]): BuiltCollection[] {
  const groups = new Map<number, MediaItem[]>()
  const info = new Map<number, { name: string; posterPath: string | null; backdropPath: string | null }>()

  for (const m of movies) {
    const col = movieMeta(m)?.collection
    if (!col) continue
    const arr = groups.get(col.tmdbId) ?? []
    arr.push(m)
    groups.set(col.tmdbId, arr)
    if (!info.has(col.tmdbId)) {
      info.set(col.tmdbId, { name: col.name, posterPath: col.posterPath ?? null, backdropPath: col.backdropPath ?? null })
    }
  }

  const out: BuiltCollection[] = []
  for (const [tmdbId, members] of groups) {
    if (members.length < 2) continue
    const meta = info.get(tmdbId)!
    const sorted = [...members].sort((a, b) => (a.year ?? 0) - (b.year ?? 0))
    out.push({
      id: hashId(`tmdb-collection:${tmdbId}`),
      name: meta.name,
      tmdbId,
      posterPath: meta.posterPath,
      backdropPath: meta.backdropPath,
      movieIds: sorted.map(m => m.id),
    })
  }
  return out
}
```

- [ ] **Step 4: Wire it into `runScan`**

In `apps/server/src/scanner/scanner.ts`:
- Change the import at line 5 from `import { detectCollections } from './collections.ts'` to `import { buildCollections } from './collections.ts'`.
- Replace lines 285-292 (the collection-rebuild block):

```ts
  const movies = deps.media.listMovies()
  const collections: Collection[] = buildCollections(movies).map(c => ({
    id: c.id,
    name: c.name,
    tmdbId: c.tmdbId,
    posterPath: c.posterPath,
    backdropPath: c.backdropPath,
    movieIds: c.movieIds,
  }))
  deps.collections.replaceAll(collections)
```

- [ ] **Step 5: Run server tests to verify**

Run: `npm -w @horizon/server exec vitest run test/collections.test.ts` then `npm -w @horizon/server run test`
Expected: PASS. If `scanner.integration.test.ts` asserted old title-heuristic collections, update those assertions to expect no collections (stub movies have no `metadata.collection`).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/scanner/collections.ts apps/server/src/scanner/scanner.ts apps/server/test/collections.test.ts
git commit -m "feat(scanner): build movie collections from TMDB, drop title heuristic"
```

### Task 6: Expose new fields on collection routes

**Files:**
- Modify: `apps/server/src/routes/library.ts:75-99`
- Test: `apps/server/test/` (add a route test; reuse an existing library/route test harness if present, else create `apps/server/test/routes.collections.test.ts`)

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/routes.collections.test.ts` (model the app/inject setup on `apps/server/test/routes.browse.test.ts`):

```ts
import { describe, it, expect } from 'vitest'
// build app with seeded collections via the same helpers routes.browse.test.ts uses
describe('GET /library/movies/collections', () => {
  it('returns posterPath/backdropPath/tmdbId per collection', async () => {
    // seed media m1,m2 + collection c1 (tmdbId 1241, poster '/p.jpg', backdrop '/b.jpg')
    const res = await app.inject({ method: 'GET', url: '/library/movies/collections', headers: authHeaders })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body[0]).toMatchObject({ id: 'c1', name: 'Harry Potter Collection', tmdbId: 1241, posterPath: '/p.jpg', backdropPath: '/b.jpg' })
    expect(body[0].movies).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm -w @horizon/server exec vitest run test/routes.collections.test.ts`
Expected: FAIL — response lacks the new fields.

- [ ] **Step 3: Add fields to both collection routes**

In `apps/server/src/routes/library.ts`, update the list route mapping (lines 78-83):

```ts
    return cols.map(c => ({
      id: c.id,
      name: c.name,
      tmdbId: c.tmdbId,
      posterPath: c.posterPath,
      backdropPath: c.backdropPath,
      movies: c.movieIds.map(id => media.getById(id)).filter((m): m is NonNullable<typeof m> => !!m),
    }))
```

And the single-collection route (lines 92-97):

```ts
      return {
        id: col.id,
        name: col.name,
        tmdbId: col.tmdbId,
        posterPath: col.posterPath,
        backdropPath: col.backdropPath,
        movies: col.movieIds.map(id => media.getById(id)).filter((m): m is NonNullable<typeof m> => !!m),
      }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm -w @horizon/server exec vitest run test/routes.collections.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/library.ts apps/server/test/routes.collections.test.ts
git commit -m "feat(api): collection endpoints return tmdbId, poster, backdrop"
```

### Task 7: SDK client — CollectionSummary + getCollection

**Files:**
- Modify: `libs/sdk/src/client.ts:145` + add method near line 146
- Create/extend type in `libs/sdk/src/collections.ts` (created in Task 9; if doing Task 7 first, define `CollectionSummary` here and import in Task 9)

- [ ] **Step 1: Define `CollectionSummary` in the SDK**

Create `libs/sdk/src/collections.ts` with the type (the merge helper is added in Task 9):

```ts
import type { MediaItem } from './types.ts'

export interface CollectionSummary {
  id: string
  name: string
  tmdbId: number | null
  posterPath: string | null
  backdropPath: string | null
  movies: MediaItem[]
}
```

Export it from the SDK barrel (`libs/sdk/src/index.ts`): add `export * from './collections.ts'`.

- [ ] **Step 2: Update client methods**

In `libs/sdk/src/client.ts`, add the import at top: `import type { CollectionSummary } from './collections.ts'` (or rely on the barrel if client imports from there). Replace line 145 and add `getCollection`:

```ts
    listCollections: () => this.fetch<CollectionSummary[]>('/library/movies/collections'),
    getCollection: (id: string) => this.fetch<CollectionSummary>(`/library/movies/collections/${id}`),
```

- [ ] **Step 3: Typecheck SDK**

Run: `npm -w @horizon/sdk run build` (or typecheck)
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add libs/sdk/src/collections.ts libs/sdk/src/client.ts libs/sdk/src/index.ts
git commit -m "feat(sdk): CollectionSummary type + getCollection client method"
```

### Task 8: Per-user preference `collapseMovieCollections`

**Files:**
- Modify: `libs/sdk/src/preferences.ts`
- Modify: `apps/web/src/pages/Settings.tsx` (DEFAULT_FORM, mergeWithDefaults, form UI)

- [ ] **Step 1: Add the schema field**

In `libs/sdk/src/preferences.ts`, add to `PreferencesSchema`:

```ts
  collapseMovieCollections: z.boolean().optional(),
```

- [ ] **Step 2: Wire defaults in Settings**

In `apps/web/src/pages/Settings.tsx`:
- Add to `DEFAULT_FORM` (after `preferredQuality: 'auto',`): `collapseMovieCollections: true,`
- Add to `mergeWithDefaults` return: `collapseMovieCollections: prefs.collapseMovieCollections ?? DEFAULT_FORM.collapseMovieCollections,`

- [ ] **Step 3: Add the toggle UI**

In the `activeTab === 'Personal'` block, under a new section after the Playback `select`, add:

```tsx
            <p className="settings__section-title">Library</p>

            <div className="settings__field">
              <div className="settings__toggle-row">
                <label className="settings__toggle-label" htmlFor="settings-collapse-collections">
                  Collapse movie collections into one item
                </label>
                <input
                  id="settings-collapse-collections"
                  type="checkbox"
                  className="settings__toggle-input"
                  checked={form.collapseMovieCollections}
                  onChange={e => set('collapseMovieCollections', e.target.checked)}
                />
              </div>
            </div>
```

- [ ] **Step 4: Typecheck web + sdk**

Run: `npm -w @horizon/sdk run build && npm -w @horizon/web run build` (or the web typecheck)
Expected: no errors. `Required<Preferences>` now includes the new key, so `DEFAULT_FORM` must define it (done in Step 2).

- [ ] **Step 5: Commit**

```bash
git add libs/sdk/src/preferences.ts apps/web/src/pages/Settings.tsx
git commit -m "feat(prefs): collapseMovieCollections toggle (default on)"
```

### Task 9: `mergeMoviesAndCollections` helper + test

**Files:**
- Modify: `libs/sdk/src/collections.ts` (add helper)
- Create: `libs/sdk/test/collections.test.ts`

- [ ] **Step 1: Write the failing test**

Create `libs/sdk/test/collections.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mergeMoviesAndCollections } from '../src/collections.ts'
import type { MediaItem } from '../src/types.ts'
import type { CollectionSummary } from '../src/collections.ts'

const mv = (id: string, title: string): MediaItem => ({ id, kind: 'movie', title } as unknown as MediaItem)
const col = (id: string, name: string, movies: MediaItem[]): CollectionSummary =>
  ({ id, name, tmdbId: null, posterPath: null, backdropPath: null, movies })

describe('mergeMoviesAndCollections', () => {
  const m1 = mv('1', 'HP1'), m2 = mv('2', 'HP2'), m3 = mv('3', 'Inception')
  const c1 = col('c1', 'Harry Potter Collection', [m1, m2])

  it('collapse off → every movie as a movie entry', () => {
    const entries = mergeMoviesAndCollections([m1, m2, m3], [c1], false)
    expect(entries).toHaveLength(3)
    expect(entries.every(e => e.kind === 'movie')).toBe(true)
  })

  it('collapse on → collection entry replaces its members; standalone movie kept once', () => {
    const entries = mergeMoviesAndCollections([m1, m2, m3], [c1], true)
    const kinds = entries.map(e => e.kind).sort()
    expect(kinds).toEqual(['collection', 'movie'])
    const colEntry = entries.find(e => e.kind === 'collection')
    expect(colEntry && colEntry.kind === 'collection' && colEntry.collection.id).toBe('c1')
    const movieEntry = entries.find(e => e.kind === 'movie')
    expect(movieEntry && movieEntry.kind === 'movie' && movieEntry.movie.id).toBe('3')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm -w @horizon/sdk exec vitest run test/collections.test.ts`
Expected: FAIL — `mergeMoviesAndCollections` not exported.

- [ ] **Step 3: Implement the helper**

Append to `libs/sdk/src/collections.ts`:

```ts
export type GridEntry =
  | { kind: 'movie'; movie: MediaItem }
  | { kind: 'collection'; collection: CollectionSummary }

/** Merge a flat movie list with collections for the Movies grid.
 *  collapse=false → every movie as its own entry (no collections).
 *  collapse=true  → one entry per collection + every movie NOT in any
 *  collection, sorted: collections by name, then movies by title. */
export function mergeMoviesAndCollections(
  movies: MediaItem[],
  collections: CollectionSummary[],
  collapse: boolean,
): GridEntry[] {
  if (!collapse) return movies.map(movie => ({ kind: 'movie', movie }))

  const inCollection = new Set<string>()
  for (const c of collections) for (const m of c.movies) inCollection.add(m.id)

  const colEntries: GridEntry[] = [...collections]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(collection => ({ kind: 'collection', collection }))

  const movieEntries: GridEntry[] = movies
    .filter(m => !inCollection.has(m.id))
    .sort((a, b) => a.title.localeCompare(b.title))
    .map(movie => ({ kind: 'movie', movie }))

  return [...colEntries, ...movieEntries]
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm -w @horizon/sdk exec vitest run test/collections.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/sdk/src/collections.ts libs/sdk/test/collections.test.ts
git commit -m "feat(sdk): mergeMoviesAndCollections grid helper"
```

### Task 10: CollectionPoster + inline Movies grid (remove Collections tab)

**Files:**
- Create: `apps/web/src/components/CollectionPoster.tsx`
- Modify: `apps/web/src/pages/Library.tsx`

- [ ] **Step 1: Create `CollectionPoster`**

Create `apps/web/src/components/CollectionPoster.tsx`:

```tsx
import { tmdbImageUrl } from '@horizon/sdk'
import type { CollectionSummary } from '@horizon/sdk'
import './LargePoster.css'

interface Props {
  collection: CollectionSummary
  width?: number
  onClick?: () => void
}

/** Collection tile for the Movies grid. Reuses poster styling; stacked look +
 *  "N films" badge mark it as a set rather than a single film. */
export default function CollectionPoster({ collection, width = 180, onClick }: Props) {
  const height = width * 1.5
  // Fall back to the first member's poster if the collection has none.
  const member = collection.movies[0]
  const memberMeta = member?.metadata?.kind === 'movie' ? member.metadata : undefined
  const poster = tmdbImageUrl(collection.posterPath ?? memberMeta?.posterPath, 'w342')
  const count = collection.movies.length

  return (
    <button
      className="poster"
      style={{ width }}
      onClick={onClick}
      aria-label={collection.name}
      data-testid="collection-card"
    >
      <div
        className="poster__art"
        style={{
          width, height,
          background: poster ? `url(${poster}) center/cover no-repeat, var(--surface)` : 'var(--surface)',
          borderRadius: Math.max(6, width * 0.05),
        }}
      >
        <div className="poster__badge">{count} films</div>
        {!poster && <div className="poster__nopo">No poster</div>}
      </div>
      <div className="poster__meta">
        <div className="poster__title">{collection.name}</div>
        <div className="poster__sub"><span>Collection</span></div>
      </div>
    </button>
  )
}
```

- [ ] **Step 2: Update `Library.tsx` — types, state, fetch**

In `apps/web/src/pages/Library.tsx`:
- Change `type Tab = 'movies' | 'shows' | 'collections'` → `type Tab = 'movies' | 'shows'`.
- Add imports: `import CollectionPoster from '../components/CollectionPoster.tsx'` and `import { mergeMoviesAndCollections } from '@horizon/sdk'` and `import type { CollectionSummary } from '@horizon/sdk'`.
- Change collections state type: `const [collections, setCollections] = useState<CollectionSummary[]>([])`.
- `tabFromUrl`: keep, but coerce any legacy `?tab=collections` to `'movies'`:
  `const raw = params.get('tab'); const tabFromUrl: Tab = raw === 'shows' ? 'shows' : 'movies'`.

- [ ] **Step 3: Compute the merged grid**

After the `hero` useMemo, add:

```tsx
  const collapse = user?.preferences.collapseMovieCollections ?? true
  const movieGrid = useMemo(
    () => mergeMoviesAndCollections(movies, collections, collapse),
    [movies, collections, collapse],
  )
```

Update the count line:

```tsx
  const activeTab = tab === 'shows' ? 'Series' : 'Movies'
  const sizeByKind = tab === 'shows' ? `${shows.length} titles` : `${movieGrid.length} items`
```

- [ ] **Step 4: Replace the tabs + movies/collections render blocks**

Replace the tabs map (the `(['movies','shows','collections'] as Tab[])` block) with:

```tsx
          <div className="lib__tabs">
            {(['movies', 'shows'] as Tab[]).map(t => (
              <button
                key={t}
                className={`lib__pill ${tab === t ? 'is-active' : ''}`}
                onClick={() => { setTab(t); navigate(`/?tab=${t}`, { replace: true }) }}
              >
                {t === 'movies' ? 'Movies' : 'Series'}
              </button>
            ))}
          </div>
```

Replace the `tab === 'movies'` block and DELETE the entire `tab === 'collections'` block:

```tsx
          {!loading && tab === 'movies' && (
            <div className="lib__grid">
              {movieGrid.map(entry =>
                entry.kind === 'collection'
                  ? <CollectionPoster key={`c-${entry.collection.id}`} collection={entry.collection} width={180}
                      onClick={() => navigate(`/collection/${entry.collection.id}`)} />
                  : <LargePoster key={entry.movie.id} item={entry.movie} width={180} showMeta
                      onClick={() => navigate(`/play/${entry.movie.id}`)} />,
              )}
              {movieGrid.length === 0 && <div className="lib__empty">No movies found.</div>}
            </div>
          )}
```

Also fix the section title near line 109: `{tab === 'movies' ? 'Movies' : 'Series'}`.

- [ ] **Step 5: Typecheck + run web build**

Run: `npm -w @horizon/web run build`
Expected: no errors; no remaining references to the `'collections'` tab.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/CollectionPoster.tsx apps/web/src/pages/Library.tsx
git commit -m "feat(web): inline movie collections in Movies grid, drop Collections tab"
```

### Task 11: Collection detail page + route

**Files:**
- Create: `apps/web/src/pages/Collection.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Create the page**

Create `apps/web/src/pages/Collection.tsx` (mirrors `Show.tsx` hero + grid):

```tsx
import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { horizon } from '../horizon.ts'
import { tmdbImageUrl } from '@horizon/sdk'
import type { CollectionSummary } from '@horizon/sdk'
import LargeTopNav from '../components/chrome/LargeTopNav.tsx'
import LargePoster from '../components/LargePoster.tsx'
import './Show.css'

export default function Collection() {
  const { collectionId } = useParams<{ collectionId: string }>()
  const navigate = useNavigate()
  const [collection, setCollection] = useState<CollectionSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!collectionId) return
    let cancelled = false
    horizon.library.getCollection(collectionId)
      .then(c => { if (!cancelled) setCollection(c) })
      .catch(err => { if (!cancelled) setError(String(err.message ?? err)) })
    return () => { cancelled = true }
  }, [collectionId])

  if (error) return (
    <div className="show show--error">
      <div className="show__err-title">Error loading collection</div>
      <div className="show__err-msg">{error}</div>
      <button className="show__err-back" onClick={() => navigate('/')}>Back</button>
    </div>
  )
  if (!collection) return <div className="show show--loading">Loading collection…</div>

  const backdrop = tmdbImageUrl(collection.backdropPath, 'w780')

  return (
    <div className="show">
      <LargeTopNav active="Movies" transparent={!!backdrop} back="/" />
      <section className="show__hero" style={backdrop ? { backgroundImage: `url(${backdrop})` } : undefined}>
        <div className="show__hero-scrim-v" />
        <div className="show__hero-content">
          <div className="eyebrow">Collection</div>
          <h1 className="show__hero-title">{collection.name}</h1>
          <div className="show__hero-meta">{collection.movies.length} films</div>
        </div>
      </section>
      <div className="show__body">
        <div className="lib__grid">
          {collection.movies.map(m => (
            <LargePoster key={m.id} item={m} width={180} showMeta onClick={() => navigate(`/play/${m.id}`)} />
          ))}
        </div>
      </div>
    </div>
  )
}
```

Verify the `show__*` class names against the actual `Show.tsx` / `Show.css` (Step 2 of Task 11 confirms). If a class differs (e.g. `show__hero-scrim-v` doesn't exist), use the names actually present in `Show.css`. Falling back to plain `lib__grid` for the body is fine.

- [ ] **Step 2: Confirm reused CSS class names**

Run: `grep -n "show__hero\|show__body\|show__hero-title\|show__hero-meta\|show__hero-content\|eyebrow" apps/web/src/pages/Show.tsx`
Adjust the JSX in Step 1 to match the names that exist. Don't invent classes.

- [ ] **Step 3: Add the route**

In `apps/web/src/App.tsx`, add the import `import Collection from './pages/Collection.tsx'` and a route after the `/show/:showId` route:

```tsx
      <Route path="/collection/:collectionId" element={<Guard><Collection /></Guard>} />
```

- [ ] **Step 4: Typecheck + build**

Run: `npm -w @horizon/web run build`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Collection.tsx apps/web/src/App.tsx
git commit -m "feat(web): collection detail page at /collection/:id"
```

---

## Final verification

- [ ] **Run the whole test suite**

Run: `npm test`
Expected: all server + sdk tests pass.

- [ ] **Manual smoke (optional, via /run or browse skill)**
  - Point a TV root at a folder with `root/anime/Show/Season 01/SxxExx` nesting → scan → each show appears separately (no "Tv" item).
  - With ≥2 owned films of one franchise and metadata refreshed → Movies grid shows one collection card; clicking opens `/collection/:id`.
  - Toggle "Collapse movie collections" off in Settings → Movies grid shows individual films again.
```
