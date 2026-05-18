# `lib/` — Sandcastle utilities

## `gh.mts` — GitHub CLI wrapper

All `gh` shell-outs in Sandcastle code or reviewer prompts **MUST** go through
`gh()` from `./gh.mts`. This provides rate-limit preflight, burst jitter, and
automatic exponential-backoff retry before surfacing a clean typed error.

### Usage

#### (a) Preflight in orchestrator entrypoint

```typescript
import { preflightRateLimit } from "./lib/gh.mts";

await preflightRateLimit(); // throws GhPreflightError if quota is below threshold
```

#### (b) Making a `gh` call

```typescript
import { ghJson } from "./lib/gh.mts";

const pr = await ghJson<{ title: string; body: string }>(
  ["pr", "view", String(prNumber), "--json", "title,body"]
);
```

Or for raw stdout/stderr:

```typescript
import { gh } from "./lib/gh.mts";

const { stdout } = await gh({ args: ["pr", "view", String(n), "--json", "title,body"] });
```

#### (c) Tuning the config

```typescript
import { gh, DEFAULT_GH_CONFIG, type GhConfig } from "./lib/gh.mts";

const cfg: GhConfig = { ...DEFAULT_GH_CONFIG, maxRetries: 5, backoffBaseMs: 2_000 };
await gh({ args: ["..."] }, cfg);
```

### Config knobs

| Knob | Default | What it controls |
|---|---|---|
| `preflightMinCore` | `200` | Minimum core API quota before the pipeline is allowed to start |
| `preflightMinGraphql` | `100` | Minimum GraphQL quota before the pipeline is allowed to start |
| `jitterThresholdMs` | `500` | Window (ms) in which a second call triggers a random sleep |
| `jitterMinMs` | `200` | Minimum jitter sleep |
| `jitterMaxMs` | `500` | Maximum jitter sleep |
| `backoffBaseMs` | `1000` | Base delay for exponential backoff on 403 retries |
| `backoffMaxMs` | `30000` | Cap on backoff delay |
| `maxRetries` | `3` | Max retry attempts before `GhRateLimitError` is thrown |

> **Issue #2 note:** These constants will move to `.sandcastle/config.json` once
> issue #2 lands. `GhConfig` and `DEFAULT_GH_CONFIG` are already exported so the
> config loader can wire them in without changing this module.

### Multi-container note

Jitter is tracked per-process via a module-scoped `lastCallAt` variable. It
softens burst load _within_ a container. Cross-container coordination is handled
by retry/backoff after a 403, which covers that case. A shared lock would be a
separate follow-up.

### Error types

| Class | When thrown |
|---|---|
| `GhPreflightError` | `preflightRateLimit()` detects quota below threshold |
| `GhRateLimitError` | `gh()` retries exhausted on a rate-limited request |

### Running tests

```sh
cd .sandcastle
npm install   # first time only
npm test
npm run typecheck
```
