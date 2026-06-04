# TV scanner fix + movie collections (collapsed inline)

Date: 2026-06-04
Status: Approved (design)

Two independent changes shipped together:

1. **Bug fix** — the TV scanner turns a whole `tv` folder into a single show
   ("Tv") instead of scanning the shows inside it.
2. **Feature** — group movie franchises (Harry Potter, etc.) into one
   "collection" item, displayed inline in the Movies grid, behind a per-user
   toggle. Collections get a detail page. The standalone Collections tab is
   removed.

---

## Part A — Scanner: detect shows by content, not by depth

### Root cause

`scanShowsPath` ([apps/server/src/scanner/scanner.ts:155-231](../../../apps/server/src/scanner/scanner.ts))
decides show directories by a fixed rule: if the scanned path is exactly a
configured shows root (`isRoot = (cfg.showsRoots ?? []).includes(pathToScan)`),
its **immediate children** are shows; episodes are then collected recursively
under each child.

When the real show folders sit one level deeper than the root assumes (a
wrapper/category level, e.g. `root/tv/ShowName/Season 01/ep`, or the root itself
is the parent of `tv`), the intermediate folder becomes the single show. It
absorbs every episode beneath it via the recursive walk, producing one show
titled "Tv", which then gets TMDB art on metadata refresh. This matches the
reported symptom exactly.

The exact-match `isRoot` check is also fragile under path normalization:
`request()` normalizes subtree paths (`path.resolve` + strip trailing slash,
[manager.ts:216](../../../apps/server/src/scanner/manager.ts)) while configured
roots are stored verbatim, so a subtree scan whose path is semantically the root
but spelled differently fails the check too.

### Fix — Plex/Jellyfin-style show detection

Replace the immediate-children assumption with content-based detection. Walk all
video files under the shows path (the walker is already recursive), keep files
matching `EPISODE_RE` (`SxxExx`), and compute each file's **show directory**:

```
parent = dirname(file)
if basename(parent) matches SEASON_RE  → showDir = dirname(parent)
else                                    → showDir = parent
```

`SEASON_RE` matches the usual season-folder spellings, case-insensitive:
`Season 01`, `Season 1`, `Series 1`, `Specials`, `S01`, `S1`. Regex:
`/^(season|series|specials)\b|^s\d{1,2}$/i`.

Guard: if the computed `showDir` equals the configured root (a loose episode
dropped directly in the root), skip the file and count it under `failed` (the
scan summary already surfaces failures). Don't manufacture a show named after
the root.

Group episodes by `showDir`. Each group becomes one show:
`title = cleanTitle(basename(showDir))`, `id = hash(showDir)`, episodes upserted
with `parentId = showId`. External IDs continue to come from the show dir name
plus the episode filename.

This removes all reliance on `isRoot` and fixed depth. Arbitrary nesting above
the show level works: `tv/`, `tv/anime/`, `tv/A-D/ShowName/...`. Intermediate
folders never become shows. Subtree scans (a single show dir, or a wrapper) use
the identical computation, so a rescan of one show still works.

Secondary robustness fix: normalize configured roots in `liveCfg()`
([manager.ts:72-75](../../../apps/server/src/scanner/manager.ts)) with
`path.resolve(r).replace(/\/+$/, '')` so `classifyPath`'s prefix test and
`fullScope` operate on canonical paths matching the normalized subtree paths.

### Scope kept intact

- Movies are unaffected (they already walk recursively and match by filename).
- Soft-delete reconciliation (`softDeleteMissing` / `softDeleteMissingUnder`)
  is unchanged — it keys off `seen` ids, which we still populate.

### Tests

- Fixture: `root/tv/anime/ShowName/Season 01/S01E01.mkv` style nesting →
  assert one show per real series, none named after the wrapper folder.
- `root/Show/Season 01/ep` → episodes attach to `Show`, season dir collapsed.
- `root/Show/ep` (no season dir) → episodes attach to `Show`.
- Loose `root/S01E01.mkv` → skipped, counted as failed, no root-named show.

---

## Part B — Movie collections (TMDB), collapsed inline

### Grouping source

Decided: TMDB `belongs_to_collection`. The existing title-heuristic
(`apps/server/src/scanner/collections.ts`) cannot group franchises whose films
have distinct titles (Harry Potter, James Bond), so it is removed.

### Data model

**MovieMetadata** (`apps/server/src/metadata/types.ts` and the SDK mirror in
`libs/sdk/src/types.ts`) gains:

```ts
collection?: {
  tmdbId: number
  name: string
  posterPath?: string | null
  backdropPath?: string | null
}
```

**TMDB mapping** (`apps/server/src/metadata/tmdb.ts` `mapMovie`): read
`belongs_to_collection` (present in the default `/movie/{id}` response, already
fetched) into the new field. Add `belongs_to_collection` to the `TmdbMovie` wire
type.

**collections table** — migration (next version after the flattened baseline)
adds nullable columns `tmdb_id INTEGER`, `poster_path TEXT`, `backdrop_path
TEXT`. The `Collection` model
([apps/server/src/repos/collections.ts](../../../apps/server/src/repos/collections.ts))
and its `replaceAll` / `list` carry these through.

```ts
interface Collection {
  id: string
  name: string
  tmdbId: number | null
  posterPath: string | null
  backdropPath: string | null
  movieIds: string[]
}
```

### Building collections (`runScan`)

Replace the `detectCollections(movies)` call in `runScan`
([scanner.ts:285-292](../../../apps/server/src/scanner/scanner.ts)) with
grouping by `metadata.collection.tmdbId`:

- For each movie whose `metadata.collection` is set, group by `collection.tmdbId`.
- Keep only groups with **≥2 owned films** (a single owned film stays a normal
  movie — same threshold the old heuristic used).
- `id = hash('tmdb-collection:' + tmdbId)`, `name`, `posterPath`, `backdropPath`
  from the collection; `movieIds` sorted by year.

Collections only materialize once metadata refresh has populated
`metadata.collection` — a fresh scan before refresh shows no collections, the
same way posters appear only after refresh. This is acceptable and documented.

Delete `apps/server/src/scanner/collections.ts` and its test file.

### API

- `GET /library/movies/collections`
  ([routes/library.ts:75](../../../apps/server/src/routes/library.ts)) — extend
  the returned objects with `posterPath` / `backdropPath` (and `tmdbId`).
- `GET /library/movies/collections/:collection` — same extra fields; already
  returns a single collection with its movies. Used by the detail page.
- `GET /library/movies` stays flat. Collapsing is a client concern (it depends
  on the per-user toggle), so no new server endpoint is needed — the client
  already fetches both movies and collections.

### Per-user setting

`PreferencesSchema` (`libs/sdk/src/preferences.ts`) gains:

```ts
collapseMovieCollections: z.boolean().optional()
```

Name chosen to avoid confusion with TV series. Default-on semantics: `undefined`
is treated as **on**. (Matches the decided default — new users see franchises
collapsed.)

Settings UI (`apps/web/src/pages/Settings.tsx`): add a toggle "Collapse movie
collections into one item" to the preferences form, wired exactly like
`subtitlesEnabled` (default checked, diffed and PATCHed to `/users/:id`).

### Movies tab (`apps/web/src/pages/Library.tsx`)

- Remove the `'collections'` tab, its render block, and the
  `collections`-as-headings layout. `Tab` becomes `'movies' | 'shows'`.
- Keep fetching movies + collections (collections now feed the inline view).
- Read the active user's `collapseMovieCollections` (undefined → on).
- Extract a pure helper for testability:

  ```ts
  type GridEntry =
    | { kind: 'movie'; movie: MediaItem }
    | { kind: 'collection'; collection: CollectionSummary }

  function mergeMoviesAndCollections(
    movies: MediaItem[],
    collections: CollectionSummary[],
    collapse: boolean,
  ): GridEntry[]
  ```

  - `collapse` off → every movie as a `movie` entry (today's behavior).
  - `collapse` on → one `collection` entry per collection, plus `movie` entries
    for movies not belonging to any collection. Standalone movies and
    collections share one grid; sort movies by title, place collections by name.
- New `CollectionPoster` component: poster from `collection.posterPath` via
  `tmdbImageUrl`, title = collection name, a stacked-card look with an "N films"
  badge. Click → `navigate('/collection/' + collection.id)`.

### Collection detail page

- New route `/collection/:collectionId`
  ([apps/web/src/App.tsx](../../../apps/web/src/App.tsx)) → `Collection.tsx`.
- Fetches `GET /library/movies/collections/:id` via a new SDK method
  `getCollection(id)`.
- Layout mirrors `Show.tsx`: full-bleed backdrop (`collection.backdropPath`),
  collection name, then a grid of member movies (`LargePoster` → `/play/:id`).

### SDK (`libs/sdk/src/client.ts`)

- `listCollections` return type gains `posterPath` / `backdropPath` / `tmdbId`.
- Add `getCollection(id)` → `GET /library/movies/collections/:id`.

### Tests

- Server: scanner nesting fixtures (Part A); collection-grouping-from-metadata
  (≥2 threshold, sort by year, fields carried); migration applies cleanly;
  route returns new fields.
- Web: `mergeMoviesAndCollections` unit — collapse on/off, standalone movies,
  movie that belongs to a collection is not also rendered standalone.

---

## Out of scope

- Manual collection editing / custom collections (TMDB-derived only).
- TV-show grouping into collections (movies only).
- Backfilling collections without a metadata refresh.
