import { performance } from "node:perf_hooks";
import type { CheckRunner, VerificationContext } from "./checks/check-runner";
import type { CheckResult } from "./verification.types";

class CheckTimeoutError extends Error {}

function failed(runner: CheckRunner, ctx: VerificationContext, code: string, message: string): CheckResult {
  return {
    check: runner.name,
    version: runner.version(ctx.checksConfig),
    status: "FAILED",
    risk: null,
    reasons: [],
    signals: runner.signalNames.map((name) => ({ name, status: "FAILED", risk: null })),
    evidence: {},
    error: { code, message },
    durationMs: 0,
  };
}

/**
 * Runs one check with a hard timeout. Never rejects: a timeout or a thrown error becomes a
 * FAILED CheckResult, so one slow check cannot block the other two (specs/006 FR-011).
 */
export async function runCheckWithTimeout(
  runner: CheckRunner,
  ctx: VerificationContext,
  timeoutMs: number,
): Promise<CheckResult> {
  const controller = new AbortController();
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CheckTimeoutError(`check exceeded ${timeoutMs} ms`));
    }, timeoutMs);
  });

  let result: CheckResult;
  try {
    result = await Promise.race([runner.run(ctx, controller.signal), timeout]);
  } catch (err) {
    result =
      err instanceof CheckTimeoutError
        ? failed(runner, ctx, "TIMEOUT", err.message)
        : failed(runner, ctx, "ERROR", err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
  return { ...result, durationMs: Math.round(performance.now() - started) };
}
