import { test } from "node:test";
import assert from "node:assert/strict";
import {
  preflightRateLimit,
  gh,
  GhPreflightError,
  GhRateLimitError,
  DEFAULT_GH_CONFIG,
  type GhConfig,
} from "./gh.mts";

type ExecResult = { stdout: string; stderr: string };
type QueueItem = { stdout?: string; stderr?: string; err?: Error & { stderr?: string } };

function makeExec(queue: QueueItem[]) {
  let i = 0;
  return async (
    _cmd: string,
    _args: string[],
    _opts: Record<string, unknown>
  ): Promise<ExecResult> => {
    const item = queue[i++] ?? { stdout: "", stderr: "" };
    if (item.err) throw item.err;
    return { stdout: item.stdout ?? "", stderr: item.stderr ?? "" };
  };
}

function makeRateLimitErr(stderrMsg: string): Error & { stderr: string } {
  return Object.assign(new Error("gh error"), { stderr: stderrMsg });
}

// Test 1: preflightRateLimit throws GhPreflightError when core remaining is below threshold
test("preflightRateLimit throws GhPreflightError when core quota is too low", async () => {
  const resetUnix = Math.floor(Date.now() / 1000) + 3600;
  const exec = makeExec([
    {
      stdout: JSON.stringify({
        resources: {
          core: { remaining: 10, reset: resetUnix },
          graphql: { remaining: 5000, reset: resetUnix },
        },
      }),
    },
  ]);

  const cfg: GhConfig = { ...DEFAULT_GH_CONFIG, preflightMinCore: 200 };

  await assert.rejects(
    () => preflightRateLimit(cfg, { exec }),
    (err: unknown) => {
      assert(
        err instanceof GhPreflightError,
        `Expected GhPreflightError, got ${String(err)}`
      );
      const expectedReset = new Date(resetUnix * 1000).toISOString();
      assert(
        err.message.includes(expectedReset),
        `Expected message to include "${expectedReset}", got: ${err.message}`
      );
      return true;
    }
  );
});

// Test 2: preflightRateLimit resolves when remaining exceeds threshold
test("preflightRateLimit resolves when quota is sufficient", async () => {
  const resetUnix = Math.floor(Date.now() / 1000) + 3600;
  const exec = makeExec([
    {
      stdout: JSON.stringify({
        resources: {
          core: { remaining: 5000, reset: resetUnix },
          graphql: { remaining: 5000, reset: resetUnix },
        },
      }),
    },
  ]);

  await assert.doesNotReject(() => preflightRateLimit(DEFAULT_GH_CONFIG, { exec }));
});

// Test 3: gh retries on secondary rate limit, succeeds on the third call
test("gh retries on secondary rate limit and returns on success", async () => {
  let calls = 0;
  const rateLimitErr = makeRateLimitErr("secondary rate limit triggered by GitHub");

  const exec = async (
    _cmd: string,
    _args: string[],
    _opts: Record<string, unknown>
  ): Promise<ExecResult> => {
    calls++;
    if (calls < 3) throw rateLimitErr;
    return { stdout: "success output", stderr: "" };
  };

  const cfg: GhConfig = {
    ...DEFAULT_GH_CONFIG,
    backoffBaseMs: 1,
    backoffMaxMs: 5,
    jitterMaxMs: 1,
    jitterThresholdMs: 0,
  };

  const result = await gh({ args: ["pr", "view", "42"] }, cfg, { exec });

  assert.equal(calls, 3);
  assert.equal(result.stdout, "success output");
});

// Test 4: gh exhausts retries and throws GhRateLimitError
test("gh throws GhRateLimitError after exhausting retries", async () => {
  const rateLimitErr = makeRateLimitErr("API rate limit exceeded for this resource");

  const exec = async (
    _cmd: string,
    _args: string[],
    _opts: Record<string, unknown>
  ): Promise<ExecResult> => {
    throw rateLimitErr;
  };

  const cfg: GhConfig = {
    ...DEFAULT_GH_CONFIG,
    maxRetries: 2,
    backoffBaseMs: 1,
    backoffMaxMs: 5,
    jitterMaxMs: 1,
    jitterThresholdMs: 0,
  };

  await assert.rejects(
    () => gh({ args: ["issue", "view", "99"] }, cfg, { exec }),
    (err: unknown) => {
      assert(
        err instanceof GhRateLimitError,
        `Expected GhRateLimitError, got ${String(err)}`
      );
      assert(
        (err as GhRateLimitError).message.includes("issue"),
        `Expected args in message, got: ${(err as GhRateLimitError).message}`
      );
      return true;
    }
  );
});

// Test 5: gh re-throws non-rate-limit errors unchanged
test("gh re-throws non-rate-limit errors unchanged", async () => {
  const notFoundErr = makeRateLimitErr("Not Found: no such pr (HTTP 404)");

  const exec = async (
    _cmd: string,
    _args: string[],
    _opts: Record<string, unknown>
  ): Promise<ExecResult> => {
    throw notFoundErr;
  };

  const cfg: GhConfig = { ...DEFAULT_GH_CONFIG, jitterThresholdMs: 0 };

  await assert.rejects(
    () => gh({ args: ["pr", "view", "9999"] }, cfg, { exec }),
    (err: unknown) => {
      assert.equal(err, notFoundErr, "Should re-throw the original error unchanged");
      return true;
    }
  );
});

// Test 6: gh applies jitter delay when called twice within jitterThresholdMs
// Uses real timers with low jitterMinMs/jitterMaxMs to keep total runtime fast.
test("gh applies jitter delay on burst calls", async () => {
  const exec = async (
    _cmd: string,
    _args: string[],
    _opts: Record<string, unknown>
  ): Promise<ExecResult> => ({ stdout: "ok", stderr: "" });

  const cfg: GhConfig = {
    ...DEFAULT_GH_CONFIG,
    jitterThresholdMs: 60_000,
    jitterMinMs: 30,
    jitterMaxMs: 50,
  };

  // First call establishes lastCallAt
  await gh({ args: ["first"] }, cfg, { exec });

  const before = Date.now();
  // Second call issued immediately after will be within jitterThresholdMs
  await gh({ args: ["second"] }, cfg, { exec });
  const elapsed = Date.now() - before;

  assert(
    elapsed >= 30,
    `Expected elapsed time ≥ jitterMinMs (30ms), got ${elapsed}ms`
  );
});
