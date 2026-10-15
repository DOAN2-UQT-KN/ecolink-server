import { runCheckWithTimeout } from "../run-check";
import type { CheckRunner, VerificationContext } from "../checks/check-runner";
import type { ChecksConfig } from "../verification-config.types";
import type { CheckResult } from "../verification.types";

const ctx = { checksConfig: {} as ChecksConfig } as VerificationContext;

function runner(run: CheckRunner["run"]): CheckRunner {
  return { name: "TRUST", signalNames: ["a", "b"], version: () => "trust@test", run };
}

const completed: CheckResult = {
  check: "TRUST",
  version: "trust@test",
  status: "COMPLETED",
  risk: 0.2,
  reasons: [],
  signals: [
    { name: "a", status: "COMPLETED", risk: 0.2 },
    { name: "b", status: "COMPLETED", risk: 0.2 },
  ],
  evidence: { x: 1 },
  durationMs: 999_999,
};

describe("runCheckWithTimeout", () => {
  it("keeps a completed result and measures durationMs", async () => {
    const r = await runCheckWithTimeout(runner(async () => completed), ctx, 1000);
    expect(r).toMatchObject({ status: "COMPLETED", risk: 0.2, evidence: { x: 1 } });
    expect(r.durationMs).toBeLessThan(1000);
  });

  it("turns a hanging check into FAILED TIMEOUT and aborts it", async () => {
    let aborted = false;
    const started = Date.now();
    const r = await runCheckWithTimeout(
      runner(
        (_ctx, signal) =>
          new Promise<CheckResult>(() => {
            signal.addEventListener("abort", () => {
              aborted = true;
            });
          }),
      ),
      ctx,
      50,
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(aborted).toBe(true);
    expect(r).toMatchObject({ status: "FAILED", risk: null, version: "trust@test", error: { code: "TIMEOUT" } });
    expect(r.signals).toEqual([
      { name: "a", status: "FAILED", risk: null },
      { name: "b", status: "FAILED", risk: null },
    ]);
  });

  it("turns a thrown error into FAILED ERROR", async () => {
    const r = await runCheckWithTimeout(
      runner(async () => {
        throw new Error("identity down");
      }),
      ctx,
      1000,
    );
    expect(r).toMatchObject({ status: "FAILED", error: { code: "ERROR", message: "identity down" } });
  });
});
