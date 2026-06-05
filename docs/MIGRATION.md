# DDD restructure — path migration map

The monorepo was reorganized from technical-layer folders into **bounded
contexts** with `domain / application / infrastructure` layering and co-located
tests. No behaviour changed. Spec:
[docs/superpowers/specs/2026-06-04-ddd-restructure-design.md](superpowers/specs/2026-06-04-ddd-restructure-design.md).

## Server (`apps/server/src`)

Old technical-layer dirs (`routes/`, `repos/`, `scanner/`, `session/`,
`transcode/`, `ws/`, `metadata/`, `auth/`, `db/`, `seed/`) are gone. New layout:

| Old | New |
|---|---|
| `activity/bus.ts`, `routes/activityStream.ts` | `contexts/activity/infrastructure/{bus,http/stream}.ts` |
| `auth/*`, `repos/users.ts`, `routes/{auth,users,authz}.ts` | `contexts/identity/infrastructure/{persistence,http,…}` |
| `scanner/*`, `repos/{media,collections,scanState}.ts`, `routes/library.ts` | `contexts/library/{domain,application,infrastructure}` |
| `metadata/*`, `routes/metadata.ts` | `contexts/metadata/{domain,application,infrastructure/tmdb,infrastructure/http}` |
| `session/*`, `transcode/*`, `ws/*`, `repos/progress.ts`, `routes/{sessions,segments,playlists,progress}.ts` | `contexts/playback/{domain,application,infrastructure}` |
| `repos/serverSettings.ts`, `routes/settings.ts` | `contexts/settings/infrastructure/{persistence,http}` |
| `config.ts`, `db/*`, `server.ts`, `index.ts`, `scheduler.ts`, `seed/*`, `routes/{errors,rate-limit,health,web,dev}.ts`, `test/helpers/*` | `platform/{config,db,http,scheduler,seed,testing,composition/bootstrap.ts,main.ts}` |

- **Entrypoint:** `apps/server/src/platform/main.ts` (was `src/index.ts`).
- **Composition root:** `platform/composition/bootstrap.ts` — the only place that
  wires concrete infrastructure into contexts.
- **Cross-context imports** go through `contexts/<ctx>/index.ts` barrels only;
  enforced by `platform/architecture.test.ts`.

## sdk (`libs/sdk/src`)

`types.ts` god-file split; modules grouped by context: `identity/`, `library/`,
`metadata/`, `playback/`, `activity/`, `shared/`, `client/`. The public surface
(`@horizon/sdk` barrel + `@horizon/sdk/preferences` subpath) is unchanged.

## web (`apps/web/src`)

Feature modules: `features/{library,playback,settings,identity}` + `shared/ui`
+ `shared/` (client, app shell). A **vitest runner** was added (`apps/web`
previously had none); web unit tests run in `npm test` and CI.

## Tests

All unit tests are co-located beside their source. The DDD dependency rule is
guarded by [apps/server/src/platform/architecture.test.ts](../apps/server/src/platform/architecture.test.ts).
