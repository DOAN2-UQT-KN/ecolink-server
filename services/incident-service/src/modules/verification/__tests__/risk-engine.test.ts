import { assess, NoCompletedCheckError } from "../risk-engine";
import type { EngineConfig } from "../verification-config.types";
import type { CheckName, CheckResult, CheckStatus } from "../verification.types";
import type { ReasonCode } from "../../../constants/report-verification";

// Seed values of engine `rules@3.0.0` (migration 20261015100100_verification_configs).
const cfg: EngineConfig = Object.freeze({
  weights: { DUPLICATE: 0.6, TRUST: 0.4, CONTEXT: 0.1 },
  thresholds: { review: 0.3, reject: 0.7 },
  duplicateFailedMinFlag: "REVIEW",
});

function check(check: CheckName, status: CheckStatus, risk: number | null, reasons: ReasonCode[] = []): CheckResult {
  return Object.freeze({ check, version: "test@1", status, risk, reasons, signals: [], evidence: {}, durationMs: 1 });
}

const run = (results: CheckResult[], c: EngineConfig = cfg) => assess(results, c, "rules@3.0.0");

describe("risk engine (rules@3.0.0)", () => {
  it("mockup example: near-image match + gallery photo -> 0.61 REVIEW", () => {
    const a = run([
      check("DUPLICATE", "COMPLETED", 0.9, ["DUP_NEAR_IMAGE_MATCH"]),
      check("TRUST", "COMPLETED", 0.32, ["TRUST_NOT_LIVE_CAPTURE"]),
      check("CONTEXT", "COMPLETED", 0),
    ]);
    expect(a.riskScore).toBeCloseTo(0.6073, 4);
    expect(a.flag).toBe("REVIEW");
    expect(a.reasons).toEqual(["DUP_NEAR_IMAGE_MATCH", "TRUST_NOT_LIVE_CAPTURE"]);
    expect(a.engineVersion).toBe("rules@3.0.0");
  });

  it("gallery photo without duplicates -> 0.12 ACCEPT", () => {
    const a = run([check("DUPLICATE", "COMPLETED", 0), check("TRUST", "COMPLETED", 0.32), check("CONTEXT", "COMPLETED", 0)]);
    expect(a.riskScore).toBeCloseTo(0.1164, 4);
    expect(a.flag).toBe("ACCEPT");
  });

  it("new user, live camera photo -> 0.08 ACCEPT", () => {
    const a = run([check("DUPLICATE", "COMPLETED", 0), check("TRUST", "COMPLETED", 0.22), check("CONTEXT", "COMPLETED", 0)]);
    expect(a.riskScore).toBeCloseTo(0.08, 4);
    expect(a.flag).toBe("ACCEPT");
  });

  it("weakest duplicate match (ORB 0.70) alone -> REVIEW", () => {
    const a = run([check("DUPLICATE", "COMPLETED", 0.7), check("TRUST", "COMPLETED", 0), check("CONTEXT", "COMPLETED", 0)]);
    expect(a.riskScore).toBeCloseTo(0.3818, 4);
    expect(a.flag).toBe("REVIEW");
  });

  it("strongest duplicate match alone never auto-rejects", () => {
    const a = run([check("DUPLICATE", "COMPLETED", 0.9), check("TRUST", "COMPLETED", 0), check("CONTEXT", "COMPLETED", 0)]);
    expect(a.riskScore).toBeCloseTo(0.4909, 4);
    expect(a.flag).toBe("REVIEW");
  });

  it.each<CheckStatus>(["SKIPPED", "FAILED"])("CONTEXT %s re-normalises weights, no guard", (status) => {
    const a = run([
      check("DUPLICATE", "COMPLETED", 0.9),
      check("TRUST", "COMPLETED", 0.32),
      check("CONTEXT", status, null),
    ]);
    expect(a.riskScore).toBeCloseTo(0.668, 4);
    expect(a.flag).toBe("REVIEW");
    expect(a.reasons.some((r) => r.startsWith("SYS_"))).toBe(false);
  });

  it("DUPLICATE FAILED forces at least REVIEW", () => {
    const a = run([check("DUPLICATE", "FAILED", null), check("TRUST", "COMPLETED", 0), check("CONTEXT", "COMPLETED", 0)]);
    expect(a.riskScore).toBe(0);
    expect(a.flag).toBe("REVIEW");
    expect(a.reasons).toContain("SYS_CHECK_FAILED_DUPLICATE");
  });

  it("no completed check -> NoCompletedCheckError", () => {
    expect(() =>
      run([check("DUPLICATE", "NOT_AVAILABLE", null), check("TRUST", "NOT_AVAILABLE", null), check("CONTEXT", "NOT_AVAILABLE", null)]),
    ).toThrow(NoCompletedCheckError);
  });

  describe("threshold boundaries belong to the upper band", () => {
    const dupOnly: EngineConfig = { ...cfg, weights: { DUPLICATE: 1, TRUST: 0, CONTEXT: 0 } };
    it.each([
      [0.2999, "ACCEPT"],
      [0.3, "REVIEW"],
      [0.7, "REJECT"],
    ])("score %s -> %s", (risk, flag) => {
      expect(run([check("DUPLICATE", "COMPLETED", risk as number)], dupOnly).flag).toBe(flag);
    });
  });

  it("duplicate + bad trust + context mismatch -> REJECT", () => {
    const a = run([
      check("DUPLICATE", "COMPLETED", 0.9, ["DUP_NEAR_IMAGE_MATCH"]),
      check("TRUST", "COMPLETED", 1, ["TRUST_NOT_LIVE_CAPTURE", "TRUST_NEW_ACCOUNT"]),
      check("CONTEXT", "COMPLETED", 0.5, ["CTX_CATEGORY_LOCATION_MISMATCH"]),
    ]);
    expect(a.riskScore).toBeCloseTo(0.9, 4);
    expect(a.flag).toBe("REJECT");
  });

  it("orders reasons by contribution, de-duplicates, engine reasons last", () => {
    const a = run([
      check("CONTEXT", "COMPLETED", 0.5, ["CTX_CATEGORY_LOCATION_MISMATCH"]),
      check("TRUST", "COMPLETED", 0.6, ["TRUST_NOT_LIVE_CAPTURE", "TRUST_NOT_LIVE_CAPTURE"]),
      check("DUPLICATE", "FAILED", null),
    ]);
    expect(a.reasons).toEqual(["TRUST_NOT_LIVE_CAPTURE", "CTX_CATEGORY_LOCATION_MISMATCH", "SYS_CHECK_FAILED_DUPLICATE"]);
  });

  it("is deterministic and does not mutate input", () => {
    const input = Object.freeze([
      check("DUPLICATE", "COMPLETED", 0.75, ["DUP_NEAR_IMAGE_MATCH"]),
      check("TRUST", "COMPLETED", 0.4),
      check("CONTEXT", "SKIPPED", null),
    ]) as CheckResult[];
    expect(run(input)).toStrictEqual(run(input));
  });
});
