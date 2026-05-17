import { execFile as nodeExecFile } from "node:child_process";

export type GhConfig = {
  preflightMinCore: number;
  preflightMinGraphql: number;
  jitterThresholdMs: number;
  jitterMinMs: number;
  jitterMaxMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  maxRetries: number;
};

export const DEFAULT_GH_CONFIG: GhConfig = {
  preflightMinCore: 200,
  preflightMinGraphql: 100,
  jitterThresholdMs: 500,
  jitterMinMs: 200,
  jitterMaxMs: 500,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  maxRetries: 3,
};

export class GhPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhPreflightError";
  }
}

export class GhRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhRateLimitError";
  }
}

type ExecResult = { stdout: string; stderr: string };
type ExecFn = (
  cmd: string,
  args: string[],
  opts: Record<string, unknown>
) => Promise<ExecResult>;

// Matches stderr phrasings across gh CLI versions. Regex set is intentionally
// broad; if a new phrasing is encountered in the wild, add it here + a test.
function isRateLimited(err: unknown): boolean {
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  if (typeof stderr !== "string") return false;
  return (
    /API rate limit exceeded/i.test(stderr) ||
    /secondary rate limit/i.test(stderr) ||
    /X-RateLimit-Remaining:\s*0/i.test(stderr)
  );
}

let lastCallAt = 0;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const rand = (min: number, max: number): number =>
  min + Math.random() * (max - min);

const MAX_BUFFER = 50 * 1024 * 1024;

const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise<ExecResult>((resolve, reject) => {
    const child = nodeExecFile(
      cmd,
      args,
      {
        timeout: opts["timeout"] as number | undefined,
        maxBuffer: MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        const out = String(stdout ?? "");
        const err = String(stderr ?? "");
        if (error) {
          (error as { stderr?: string }).stderr = err;
          reject(error);
        } else {
          resolve({ stdout: out, stderr: err });
        }
      }
    );
    if (typeof opts["input"] === "string" && child.stdin) {
      child.stdin.write(opts["input"]);
      child.stdin.end();
    }
  });

export async function preflightRateLimit(
  cfg: GhConfig = DEFAULT_GH_CONFIG,
  _internal?: { exec?: ExecFn }
): Promise<void> {
  const exec = _internal?.exec ?? defaultExec;
  const { stdout } = await exec("gh", ["api", "rate_limit"], {});
  const data = JSON.parse(stdout) as {
    resources: {
      core: { remaining: number; reset: number };
      graphql: { remaining: number; reset: number };
    };
  };
  const { core, graphql } = data.resources;
  if (core.remaining < cfg.preflightMinCore) {
    const reset = new Date(core.reset * 1000).toISOString();
    throw new GhPreflightError(
      `GitHub core quota too low: ${core.remaining} remaining (need ≥ ${cfg.preflightMinCore}). Resets at ${reset}.`
    );
  }
  if (graphql.remaining < cfg.preflightMinGraphql) {
    const reset = new Date(graphql.reset * 1000).toISOString();
    throw new GhPreflightError(
      `GitHub graphql quota too low: ${graphql.remaining} remaining (need ≥ ${cfg.preflightMinGraphql}). Resets at ${reset}.`
    );
  }
}

export async function gh(
  opts: { args: string[]; input?: string; timeoutMs?: number },
  cfg: GhConfig = DEFAULT_GH_CONFIG,
  _internal?: { exec?: ExecFn }
): Promise<{ stdout: string; stderr: string }> {
  const exec = _internal?.exec ?? defaultExec;

  const now = Date.now();
  if (lastCallAt > 0 && now - lastCallAt < cfg.jitterThresholdMs) {
    await sleep(rand(cfg.jitterMinMs, cfg.jitterMaxMs));
  }
  lastCallAt = Date.now();

  for (let attempt = 0; ; attempt++) {
    try {
      return await exec("gh", opts.args, {
        input: opts.input,
        timeout: opts.timeoutMs,
      });
    } catch (err) {
      if (isRateLimited(err)) {
        if (attempt < cfg.maxRetries) {
          const delay =
            Math.min(cfg.backoffMaxMs, cfg.backoffBaseMs * 2 ** attempt) +
            rand(0, cfg.jitterMaxMs);
          await sleep(delay);
          continue;
        }
        throw new GhRateLimitError(
          `GitHub rate limit exhausted after ${attempt + 1} attempt(s): gh ${opts.args.join(" ")}`
        );
      }
      throw err;
    }
  }
}

export async function ghJson<T>(
  args: string[],
  cfg?: GhConfig,
  _internal?: { exec?: ExecFn }
): Promise<T> {
  const { stdout } = await gh({ args }, cfg, _internal);
  return JSON.parse(stdout) as T;
}
