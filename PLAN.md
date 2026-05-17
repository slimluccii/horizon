# Plan for issue #3: GitHub rate-limit guard for the Sandcastle pipeline

## Goal
Add a self-contained `gh` wrapper module at `.sandcastle/lib/gh.mts` that every Sandcastle `gh` shell-out (orchestrator code and the pattern reviewer prompts reference) can call. The wrapper performs a preflight quota check, applies inter-call jitter under burst load, and retries 403/secondary-rate-limit responses with capped exponential backoff before surfacing a clean typed error.

## Scope
- Expected files changed: **5** (all new)
- Expected lines changed: **~380** (additions)
- Within soft caps: **yes**
- If no, justification: n/a

## Files to change
- `.sandcastle/package.json` — new. `"type": "module"`, declares `tsx` + `typescript` + `@types/node` as devDeps, scripts: `test`, `typecheck`. Standalone (not added to root `workspaces` to keep root diff zero) so the orchestrator stays decoupled from the app workspaces.
- `.sandcastle/tsconfig.json` — new. Extends `../tsconfig.base.json`, sets `"module": "NodeNext"`, `"target": "ES2022"`, `"types": ["node"]`, `"strict": true`, no `outDir` (run with `tsx`).
- `.sandcastle/lib/gh.mts` — new. The wrapper module. Exports:
  - `type GhConfig` and `DEFAULT_GH_CONFIG` (the tunable constants).
  - `class GhPreflightError extends Error` and `class GhRateLimitError extends Error`.
  - `async preflightRateLimit(cfg?): Promise<void>` — runs `gh api rate_limit`, throws `GhPreflightError` when `core.remaining < cfg.preflightMinCore` or `graphql.remaining < cfg.preflightMinGraphql`, with reset time in the message.
  - `async gh(opts: {args, input?, timeoutMs?}, cfg?): Promise<{stdout, stderr}>` — the universal wrapper. Tracks `lastCallAt` in a module-scoped variable; if `now - lastCallAt < cfg.jitterThresholdMs`, sleeps `random(jitterMinMs, jitterMaxMs)` before invoking `execFile("gh", args, {input, timeout, maxBuffer: 50MB})`. On rejection, calls `isRateLimited(err)` (matches `/API rate limit exceeded/i`, `/secondary rate limit/i`, or `/X-RateLimit-Remaining:\s*0/i` against `err.stderr`); if true and `attempt < cfg.maxRetries`, sleeps `min(backoffMaxMs, backoffBaseMs * 2**attempt) + random(0, jitterMaxMs)` and retries; on exhaustion throws `GhRateLimitError`; non-rate-limit errors re-throw unchanged.
  - `async ghJson<T>(args, cfg?): Promise<T>` — convenience: calls `gh` then `JSON.parse(stdout)`.
  - Internal `execFile` is injected via an optional `{ exec }` factory parameter on `gh()` so tests can swap a fake without monkey-patching globals (kept as a non-exported overload to keep the public surface minimal).
- `.sandcastle/lib/gh.test.mts` — new. Uses Node's built-in `node:test` runner (zero dep beyond what `tsx` already provides). Test cases:
  1. `preflightRateLimit` throws `GhPreflightError` when injected exec returns `{core:{remaining: 10, reset:...}}` and threshold is 200. Asserts message includes the reset ISO time.
  2. `preflightRateLimit` resolves when remaining > threshold.
  3. `gh` retries on a forced 403 with `secondary rate limit` stderr, then succeeds on attempt 3. Asserts `execFile` was called 3 times and final stdout returned.
  4. `gh` exhausts retries on persistent 403 and rejects with `GhRateLimitError` (NOT an uncaught exception or generic `Error`). Asserts message names the failing args.
  5. `gh` re-throws non-rate-limit errors unchanged (e.g. a 404 "Not Found" stderr).
  6. `gh` applies jitter delay when called twice within `jitterThresholdMs`. Uses a low `jitterMinMs/jitterMaxMs` (e.g. 30/50ms) and asserts measured gap ≥ `jitterMinMs`. Uses real timers (kept fast — total test run < 2s) rather than fake timers to avoid coupling to internal `setTimeout` shape.
  All tests inject a fake `exec` that returns a pre-scripted queue of `{stdout, stderr, error?}` so no real `gh` calls happen.
- `.sandcastle/lib/README.md` — new. ~40 lines. Documents the pattern: "All `gh` shell-outs in Sandcastle code or reviewer prompts MUST go through `gh()` from `./gh.mts`." Shows three snippets: (a) preflight in orchestrator entrypoint, (b) `await gh({ args: ["pr", "view", String(n), "--json", "title,body"] })`, (c) tuning the config object. Lists every knob with its default and what it controls. Calls out that constants will move to `.sandcastle/config.json` once issue #2 lands.

## Out of scope
- Refactoring orchestrator call sites — the orchestrator (`.sandcastle/main.mts` with `fetchPRMeta`, `findPRForBranch`, `waitForCI`, etc.) is not in this repo yet (no `.sandcastle/` directory exists on `main`). Those call sites will adopt `gh()` as they are introduced via the sibling issues. This issue ships the helper + the documented pattern; the README explicitly states the migration contract.
- Externalizing the config to `.sandcastle/config.json` — owned by issue #2. We expose `GhConfig` + `DEFAULT_GH_CONFIG` so #2 can wire its loaded config straight in without changing the wrapper.
- Top-level `.sandcastle/README.md` (issue #1).
- Touching the root `package.json` / lockfile / `workspaces` array. `.sandcastle/` stays a standalone npm project; its `node_modules` is local. (If a contributor objects, adding `".sandcastle"` to the root `workspaces` array is a one-line follow-up — flagged in the README.)
- Graphql-specific quota handling beyond a single `preflightMinGraphql` threshold; the per-resource `search` / `code_scanning_upload` quotas are not consumed by the pipeline today.
- Detection of token-revocation 401s (out of scope — that's an auth issue, not a rate-limit one).

## Steps
1. Create `.sandcastle/` directory.
2. Write `.sandcastle/tsconfig.json` (extends base, NodeNext, node types).
3. Write `.sandcastle/package.json` with `"type": "module"`, devDeps `tsx@^4`, `typescript@^5`, `@types/node@^20`, scripts `"test": "node --import tsx --test lib/*.test.mts"` and `"typecheck": "tsc --noEmit"`.
4. Run `npm install` inside `.sandcastle/` to generate its lockfile and verify deps resolve.
5. Write `.sandcastle/lib/gh.mts` — start with the types and `DEFAULT_GH_CONFIG`, then `isRateLimited`, then `preflightRateLimit`, then `gh` (with injectable exec for testability), then `ghJson`. Keep the module under ~150 lines.
6. Write `.sandcastle/lib/gh.test.mts` test-first style — write each test, watch it fail, then add the corresponding behavior to `gh.mts` if not already there. Order: preflight tests → retry-then-succeed → exhaust-retries → non-rate-limit passthrough → jitter timing.
7. Write `.sandcastle/lib/README.md` documenting the pattern, the knobs, and the issue-#2 migration note.
8. Run `npm test` and `npm run typecheck` from `.sandcastle/`. All green.
9. Manually sanity-check the real wrapper against the live API: `node --import tsx -e "import('./lib/gh.mts').then(m => m.preflightRateLimit().then(() => console.log('ok')))"` — should print `ok` when quota is healthy. (Document in PR description; not committed.)
10. Commit. Title: `feat(sandcastle): centralized gh wrapper with preflight + backoff`.

## Tests
- All new tests live in `.sandcastle/lib/gh.test.mts` (Node built-in `node:test`, no vitest dep). Six cases enumerated in the Files section.
- Test-first: **yes**. Write the failing tests in step 6 before filling out the matching behavior. The retry test in particular drives the loop structure; the jitter test drives the `lastCallAt` tracking.
- Coverage target is behavioral, not numeric: every public export touched by at least one test; every branch in `isRateLimited` exercised by the retry-then-succeed and the passthrough cases.
- No changes to existing test suites — Horizon server/web/sdk tests stay untouched. The `npm test` script at the repo root is unmodified, so CI behavior for the rest of the repo is unchanged.

## Verification commands
- `cd .sandcastle && npm install`
- `cd .sandcastle && npm test`           — all 6 cases pass, total runtime < 3s
- `cd .sandcastle && npm run typecheck`  — zero errors
- `cd .sandcastle && node --import tsx -e "import('./lib/gh.mts').then(m => m.preflightRateLimit().then(() => console.log('preflight ok')))"` — exits 0 when token is healthy
- `cd .sandcastle && node --import tsx -e "import('./lib/gh.mts').then(m => m.gh({args:['--version']}).then(r => console.log(r.stdout.split(String.fromCharCode(10))[0])))"` — prints the local `gh` version string (sanity: real exec path works)
- `npm test` at repo root — unchanged, still green (regression check on the rest of the repo)

## Risks / open questions
- **Module-scoped `lastCallAt`** — fine for the single-process orchestrator pattern but won't coordinate jitter across parallel containers sharing a token. The issue explicitly names this multi-container case as the problem, so call it out in the README: per-process jitter softens bursts within a container; cross-container coordination is left to retry/backoff after a 403, which DOES handle the multi-container case. Acceptable tradeoff for this PR; a shared lock (Redis/file) would be its own issue.
- **Detecting secondary rate limits reliably** — `gh` surfaces them in stderr but the wording can drift across `gh` versions. The regex set (`/API rate limit exceeded/i`, `/secondary rate limit/i`, `/X-RateLimit-Remaining:\s*0/i`) is broad enough to catch current phrasings; if it misses a variant in practice, add the regex and a test. Document this in a code comment on `isRateLimited`.
- **`tsx` as the test runner** — chosen over vitest to keep `.sandcastle/` deps small and to match a "minimal infra" feel for an orchestrator. If the project later prefers vitest for symmetry with `apps/server`, swap is trivial (one devDep + change the `test` script); the test file uses standard `node:test` shape which both runners understand the assertion style of.
- **No `.sandcastle/` in root workspaces array** — keeps the root `package.json` diff zero, but means contributors must `cd .sandcastle && npm install` once. The README states this. If reviewer prefers workspace integration, +1 line to root `package.json` and re-running root `npm install`. Flagged but not the default.
- **Preflight thresholds** — defaults of `core: 200`, `graphql: 100` are conservative guesses sized for a multi-PR pipeline run; real numbers should come from observed usage once the orchestrator is running. The constants are the right place for now (per the issue) and will move to config in #2.
- **No orchestrator to refactor in-repo** — acceptance criterion "single helper module is used for every gh shell-out in the orchestrator" is partially deferrable: the helper exists and the pattern is documented, so any orchestrator code added later (in the sibling issues) is bound by the documented contract. Flagged in the PR description.
