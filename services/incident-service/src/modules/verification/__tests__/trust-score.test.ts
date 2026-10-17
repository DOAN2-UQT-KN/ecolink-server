import { scoreTrust } from "../checks/trust-score";
import type { ChecksConfig } from "../verification-config.types";

// Seed values of checks@1.0.0 (migration 20261015100100_verification_configs).
const cfg: ChecksConfig["trust"] = {
  version: "trust@1.0.0",
  weights: { capture: 0.5, reject_history: 0.35, account_age: 0.15 },
  galleryRisk: 0.6,
  rejectWindowDays: 90,
  smoothing: { addRejected: 1, addTotal: 5 },
  highRejectMinTotal: 3,
  highRejectRate: 0.5,
  accountAgeSteps: [
    { belowDays: 1, risk: 1.0 },
    { belowDays: 7, risk: 0.4 },
  ],
  newAccountDays: 7,
};

const sig = (r: ReturnType<typeof scoreTrust>, name: string) => r.signals.find((s) => s.name === name)!;

describe("scoreTrust", () => {
  it("new user, live photo, no history -> 0.22", () => {
    const r = scoreTrust({ images: { live: 1, gallery: 0 }, history: { total: 0, rejected: 0 }, accountAgeDays: 0 }, cfg);
    expect(r.status).toBe("COMPLETED");
    expect(r.risk).toBeCloseTo(0.22, 4);
    expect(r.reasons).toEqual(["TRUST_NEW_ACCOUNT"]);
  });

  it("long-standing user with a gallery photo -> ~0.32 (mockup)", () => {
    const r = scoreTrust({ images: { live: 0, gallery: 1 }, history: { total: 12, rejected: 0 }, accountAgeDays: 140 }, cfg);
    expect(r.risk).toBeCloseTo(0.3206, 4);
    expect(r.reasons).toEqual(["TRUST_NOT_LIVE_CAPTURE"]);
    expect(sig(r, "reject_history").risk).toBeCloseTo(1 / 17, 4);
    expect(r.evidence).toEqual({ images: { live: 0, gallery: 1 }, totalReports90d: 12, rejected90d: 0, accountAgeDays: 140 });
  });

  it("often rejected -> smoothed rate and TRUST_HIGH_REJECT_RATE", () => {
    const r = scoreTrust({ images: { live: 1, gallery: 0 }, history: { total: 10, rejected: 6 }, accountAgeDays: 100 }, cfg);
    expect(sig(r, "reject_history").risk).toBeCloseTo(7 / 15, 4);
    expect(r.reasons).toContain("TRUST_HIGH_REJECT_RATE");
  });

  it("too little history for the high-reject reason", () => {
    const r = scoreTrust({ images: { live: 1, gallery: 0 }, history: { total: 2, rejected: 2 }, accountAgeDays: 100 }, cfg);
    expect(r.reasons).not.toContain("TRUST_HIGH_REJECT_RATE");
  });

  it.each([
    [3, 0.4, true],
    [7, 0, false],
  ])("account %s days -> risk %s", (days, risk, isNew) => {
    const r = scoreTrust({ images: { live: 1, gallery: 0 }, history: { total: 0, rejected: 0 }, accountAgeDays: days }, cfg);
    expect(sig(r, "account_age").risk).toBe(risk);
    expect(r.reasons.includes("TRUST_NEW_ACCOUNT")).toBe(isNew);
  });

  it("identity down -> account_age FAILED, check still completes on the other weights", () => {
    const r = scoreTrust({ images: { live: 0, gallery: 1 }, history: { total: 0, rejected: 0 }, accountAgeDays: "FAILED" }, cfg);
    expect(sig(r, "account_age").status).toBe("FAILED");
    expect(r.status).toBe("COMPLETED");
    expect(r.risk).toBeCloseTo((0.5 * 0.6 + 0.35 * 0.2) / 0.85, 4);
  });

  it("report without user -> only capture is scored", () => {
    const r = scoreTrust({ images: { live: 0, gallery: 2 }, history: null, accountAgeDays: null }, cfg);
    expect(r.signals.map((s) => s.status)).toEqual(["COMPLETED", "SKIPPED", "SKIPPED"]);
    expect(r.risk).toBeCloseTo(0.6, 4);
  });

  it("nothing to score -> SKIPPED with null risk", () => {
    const r = scoreTrust({ images: null, history: null, accountAgeDays: null }, cfg);
    expect(r).toMatchObject({ status: "SKIPPED", risk: null, reasons: [] });
  });
});
