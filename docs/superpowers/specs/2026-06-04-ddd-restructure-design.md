# Domain-Driven restructure (all packages)

Date: 2026-06-04
Status: Approved (design)

Restructure the whole monorepo around **bounded contexts** with a strict
domain → application → infrastructure layering, **co-located tests**, and
per-context path aliases. One big-bang PR. Behaviour is preserved (pure
restructuring + renames), but the project is unreleased so **no backward-compat
constraints** apply — barrels, public surfaces, and names may change freely
wherever it improves clarity.

> **Risk acknowledged:** this is a very large diff (~90 source + 61 test files
> moved/relayered, imports rewritten, a web test runner added). Reviewability is
> the main cost; mitigations are in §8. Chosen deliberately over an incremental
> rollout.

---

## 1. Principles

1. **Bounded contexts over technical layers.** Group by domain
   (`identity`, `library`, …), not by kind (`routes/`, `repos/`).
2. **Strict layering + dependency rule.** Within a context:
   `domain ← application ← infrastructure`. Source code dependencies point
   inward only. The domain layer imports nothing outward (no Fastify, no
   better-sqlite3, no TMDB, no fs).
3. **Ports & adapters.** The domain/application layers declare **ports**
   (TypeScript interfaces — `MediaRepo`, `TmdbProvider`, `ActivityBus`, …);
   infrastructure provides **adapters** that implement them. HTTP routes are
   inbound adapters; repos/clients are outbound adapters.
4. **One composition root.** Only `platform/` wires concrete infrastructure into
   application services. No context constructs another context's infrastructure.
5. **Cross-context calls go through application APIs**, never another context's
   infrastructure or domain internals.
6. **Co-located tests.** Every test sits beside its unit (`x.ts` + `x.test.ts`).
7. **No god-files / dumping grounds.** Split `types.ts` and `index.ts`
   catch-alls into named modules. Barrels exist only as a context/layer's
   intentional public surface.

---

## 2. Bounded contexts (server)

| Context | Responsibility | Current files absorbed |
|---|---|---|
| **identity** | users, roles, passwords, auth sessions, pairing | `auth/*`, `repos/users`, `routes/{auth,users,authz}` |
| **library** | media items, scanning, collections, library queries | `scanner/*`, `repos/{media,collections,scanState}`, `routes/library` |
| **metadata** | TMDB enrichment, changes feed, refresh | `metadata/*`, `routes/metadata` |
| **playback** | playback sessions, transcode, segments, ws, watch progress | `session/*`, `transcode/*`, `ws/*`, `repos/progress`, `routes/{sessions,segments,playlists,progress}` |
| **activity** | activity event bus + SSE stream | `activity/*`, `routes/activityStream` |
| **settings** | server settings singleton | `repos/serverSettings`, `routes/settings` |
| **platform** | composition root + shared kernel | `config`, `db/*`, `server`, `index`, `scheduler`, `seed`, `routes/{errors,rate-limit,health,web,dev}` |

Decisions on the two open questions:
- **progress → playback.** Watch progress is a playback concern (position,
  watched %, continue-watching). It is not its own context.
- **platform = shared kernel + composition root**, internally split (see §4), not
  one bucket. It holds genuinely cross-cutting infra (db connection, config,
  HTTP bootstrap, error envelope, rate limiting, health, static web, scheduler,
  dev seed) plus `server.ts`/`index.ts` as the wiring root.

---

## 3. Layer layout per context

```
apps/server/src/contexts/<ctx>/
  domain/           entities, value objects, domain services, PORTS, pure rules
  application/      use-cases / orchestrating services (depend on domain + ports)
  infrastructure/
    persistence/    repo adapters (better-sqlite3)
    http/           Fastify route adapters (inbound)
    <external>/     e.g. tmdb/, ffmpeg/, fs/ outbound adapters
  index.ts          the context's intentional public surface (application API + types)
```

Not every context needs every folder — small contexts (activity, settings) may
have only `domain` + `infrastructure`. Don't manufacture empty layers
(pragmatic DDD; the layering is a rule, not a quota).

**Example — library:**
```
contexts/library/
  domain/
    mediaItem.ts            MediaItem/Show/Episode types + invariants
    collection.ts           Collection model + buildCollections rule
    showDetection.ts        SEASON_DIR_RE + showDirForEpisode (pure)
    ids.ts                  external-id parsing
    ports.ts                MediaRepo, CollectionsRepo, ScanRootsRepo, FileWalker, Probe
  application/
    scanManager.ts          single-flight dispatcher
    runScan.ts              scan orchestration
  infrastructure/
    persistence/{mediaRepo,collectionsRepo,scanStateRepo}.ts
    fs/{walker,watcher}.ts
    probe/probe.ts          ffprobe adapter
    http/libraryRoutes.ts
  index.ts
```

Each `.ts` gets its `.test.ts` beside it.

---

## 4. platform (shared kernel + composition root)

```
apps/server/src/platform/
  config/config.ts
  db/{connection,migrations,rowSchemas}.ts
  http/{server,errors,rateLimit,health,web,dev}.ts   inbound infra shared by all
  scheduler/scheduler.ts
  seed/scenarios.ts
  testing/                 shared test helpers (was test/helpers)
  composition/
    bootstrap.ts           builds repos + workers + wires contexts (was index.ts body)
  main.ts                  process entrypoint (thin; calls bootstrap)
```

`bootstrap.ts` is the single place that imports every context's infrastructure
and wires it to application services — the composition root. Contexts never
import `platform/composition`.

---

## 5. Path aliases (tsconfig)

Add per-context aliases so the dependency direction is visible and imports stop
being `../../../`:

```jsonc
// tsconfig.base.json compilerOptions.paths
"@identity/*": ["apps/server/src/contexts/identity/*"],
"@library/*":  ["apps/server/src/contexts/library/*"],
"@metadata/*": ["apps/server/src/contexts/metadata/*"],
"@playback/*": ["apps/server/src/contexts/playback/*"],
"@activity/*": ["apps/server/src/contexts/activity/*"],
"@settings/*": ["apps/server/src/contexts/settings/*"],
"@platform/*": ["apps/server/src/platform/*"]
```

Cross-context imports use a context's `index.ts` only: `import { scanManager }
from '@library'` (resolve `@library` → `contexts/library/index.ts`). Deep
imports across contexts are disallowed by convention (and a lint rule if cheap).

---

## 6. sdk → contracts + client

Reframe `@horizon/sdk` as the **shared contracts + HTTP client**, grouped by the
same contexts. Split `types.ts` (god-file) and the flat modules:

```
libs/sdk/src/
  identity/{user,preferences}.ts
  library/{mediaItem,collection}.ts
  metadata/metadata.ts
  playback/{session,capabilities,bandwidth,wsMessages}.ts
  activity/{events,reducer}.ts
  shared/{errors,http}.ts        common DTO + error shapes
  client/client.ts               HorizonClient (grouped methods per context)
  index.ts                       public barrel
```

Tests co-locate (`reducer.ts` + `reducer.test.ts`). Free to rename exports for
clarity — web is updated in the same PR.

---

## 7. web → feature modules + test runner

```
apps/web/src/
  features/
    library/    pages (Library, Collection, Show) + hooks + feature components
    playback/   Player + playback hooks
    settings/   Settings + ScanStatusBadge + ActivityLogPanel + useActivityStream
    identity/   Login, Setup, profile/guard
  shared/ui/    Button, Checkbox, Input, Select, Radio, Label, TextArea, chrome/*
  shared/       horizon client instance, app shell, router (App.tsx)
  main.tsx
```

**Add a vitest runner to web** (currently none): `vitest` + `@testing-library`
where needed, a `test` script, and co-locate the reducer/pure-logic tests that
today live in sdk only because web couldn't run them. `mergeMoviesAndCollections`
and `activityReducer` stay in sdk (shared), but any web-only pure helpers get
tests here.

---

## 8. Execution & risk mitigation

Big-bang, single PR. Steps (detailed in the plan):
1. Create the target tree; **`git mv`** every file (preserve history).
2. Rewrite imports mechanically (path aliases + new locations); update
   `tsconfig.base.json` paths, each package `tsconfig`, and vitest configs.
3. Split god-files (`sdk types.ts`, `metadata/index.ts`, etc.) into named modules.
4. Add the web vitest runner.
5. Remove stale build artifacts (`apps/server/test/config.test.d.ts`,
   `*.test.js.map`, `*.test.d.ts.map`) and gitignore them.
6. Green gate: `tsc --noEmit` (server), `npm test` (server+sdk), web build +
   web tests, and e2e — all pass before merge.

**Behaviour is unchanged** — no logic edits, only moves, renames, and import
rewrites. Any behavioural change is out of scope and a bug.

Risks & mitigations:
- **Huge diff / hard review** → history-preserving `git mv`; commit per context
  (still one PR) so the diff reads context-by-context; a `MIGRATION.md` mapping
  table old→new path.
- **Broken imports** → leaning on `tsc --noEmit` + path aliases as the safety net;
  CI must be green.
- **Hidden cross-layer deps surfaced** (domain importing infra) → fix by moving
  the offending code or introducing a port; note each in the PR.
- **e2e/runtime wiring** (the composition root move) is the highest-risk single
  step → keep `bootstrap.ts` a faithful move of the current `index.ts` body.

---

## 9. Out of scope

- Behavioural changes / features / bug fixes (restructure only).
- A DI framework (plain composition root, no container).
- Android-TV / macOS apps (not part of the web/server/sdk core).
- Splitting into separately-published packages (stays a monorepo with aliases).
