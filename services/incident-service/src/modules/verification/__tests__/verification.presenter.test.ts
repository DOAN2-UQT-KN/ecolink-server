import type { ModerationReasonCode } from "@prisma/client";
import { toAdminView, toUserView } from "../verification.presenter";
import type { VerificationWithChecks } from "../verification-query.service";

function verification(over: Partial<VerificationWithChecks> = {}): VerificationWithChecks {
  return {
    id: "v1",
    reportId: "r1",
    attempt: 1,
    status: "COMPLETED",
    pipelineVersion: "2.3.0",
    engineVersion: "rules@3.0.0",
    riskScore: 0.61,
    flag: "REVIEW",
    reasons: ["DUP_NEAR_IMAGE_MATCH", "TRUST_NOT_LIVE_CAPTURE", "TRUST_NEW_ACCOUNT", "SYS_CHECK_FAILED_DUPLICATE"],
    startedAt: new Date("2026-10-16T08:00:00Z"),
    completedAt: new Date("2026-10-16T08:00:04Z"),
    checks: [
      {
        id: "c1",
        verificationId: "v1",
        check: "DUPLICATE",
        version: "duplicate@2.0.0",
        status: "COMPLETED",
        risk: 0.9,
        reasons: ["DUP_NEAR_IMAGE_MATCH"],
        signals: [{ name: "phash", status: "COMPLETED", risk: 0.9, raw: 4 }],
        evidence: {
          candidates_scanned: 3,
          match: { report_id: "r-old", user_id: "u-other", same_user: false, distance_m: 120, time_delta_hours: 2 },
        },
        error: null,
        durationMs: 800,
      },
    ],
    ...over,
  };
}

const report = (status: number, moderationReasonCode: ModerationReasonCode | null = null) => ({
  id: "r1",
  status,
  moderationReasonCode,
  moderatedBy: moderationReasonCode ? "admin-1" : null,
  moderatedAt: moderationReasonCode ? new Date("2026-10-16T09:00:00Z") : null,
});

describe("toUserView", () => {
  it("keeps only public reasons, in engine order", () => {
    const view = toUserView(verification(), report(9));
    expect(view.issues.map((i) => i.code)).toEqual(["DUP_NEAR_IMAGE_MATCH", "TRUST_NOT_LIVE_CAPTURE"]);
    expect(view.flag).toBe("REVIEW");
  });

  it("shows no issue when only admin-only reasons remain", () => {
    const view = toUserView(verification({ reasons: ["TRUST_NEW_ACCOUNT", "SYS_CHECK_FAILED_DUPLICATE"] }), report(9));
    expect(view.issues).toEqual([]);
    expect(view.flag).toBe("REVIEW");
  });

  it("gives minimal duplicate evidence and never leaks identity or scores", () => {
    const view = toUserView(verification(), report(9));
    expect(view.issues[0].evidence).toEqual({ similar_report_id: "r-old", distance_m: 120, time_delta_hours: 2 });
    const json = JSON.stringify(view);
    for (const forbidden of ['"user_id"', '"same_user"', '"risk"', '"riskScore"', "u-other"]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("hides the verdict while running", () => {
    const view = toUserView(verification({ status: "RUNNING", flag: null, reasons: [] }), report(12));
    expect(view).toMatchObject({ status: "RUNNING", flag: null, issues: [] });
  });

  it("puts the moderator's reason first when rejected", () => {
    const view = toUserView(verification(), report(2, "NOT_ON_SITE"));
    expect(view.issues[0]).toMatchObject({ code: "TRUST_NOT_LIVE_CAPTURE", primary: true });
    expect(view.issues.map((i) => i.code)).toEqual(["TRUST_NOT_LIVE_CAPTURE", "DUP_NEAR_IMAGE_MATCH"]);
  });

  it("adds a synthetic MOD_ issue when the reason has no pipeline code", () => {
    const view = toUserView(verification(), report(2, "INAPPROPRIATE_CONTENT"));
    expect(view.issues[0]).toEqual({ code: "MOD_INAPPROPRIATE_CONTENT", primary: true, evidence: {} });
    expect(view.issues).toHaveLength(3);
  });

  it("marks no primary reason unless the report is rejected", () => {
    const view = toUserView(verification(), report(9, "NOT_ON_SITE"));
    expect(view.issues.every((i) => !i.primary)).toBe(true);
  });
});

describe("toAdminView", () => {
  it("exposes score, every reason, checks and the moderation decision", () => {
    const view = toAdminView(verification(), report(2, "DUPLICATE_OF_OTHER"));
    expect(view).toMatchObject({
      riskScore: 0.61,
      reasons: ["DUP_NEAR_IMAGE_MATCH", "TRUST_NOT_LIVE_CAPTURE", "TRUST_NEW_ACCOUNT", "SYS_CHECK_FAILED_DUPLICATE"],
      versions: { pipeline: "2.3.0", engine: "rules@3.0.0" },
      moderation: { decision: "REJECT", reasonCode: "DUPLICATE_OF_OTHER", by: "admin-1" },
    });
    expect(view.checks.DUPLICATE).toMatchObject({ risk: 0.9, durationMs: 800, signals: [{ name: "phash" }] });
  });

  it("has no moderation block before a decision", () => {
    expect(toAdminView(verification(), report(9)).moderation).toBeNull();
  });
});
