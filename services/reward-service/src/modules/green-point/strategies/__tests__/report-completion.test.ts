import type { PointRulesSnapshot } from "../../../gamification/gamification-config.service";
import {
  ReportCompletionGreenPointStrategy,
  resolveReportCompletionCredits,
} from "../report-completion-green-point.strategy";

const rules = (reportCompletionPoints: number): PointRulesSnapshot => ({
  id: "rule-1",
  campaignCompletionPoints: 20,
  baseReportPoint: 5,
  reportMilestoneThresholds: [],
  reportCompletionPoints,
  pointExpirationDays: 90,
});

describe("resolveReportCompletionCredits", () => {
  it("credits the configured points once, sourced to the report", () => {
    expect(resolveReportCompletionCredits({ reportId: "r1", userId: "u1" }, rules(10))).toEqual([
      {
        userId: "u1",
        points: 10,
        transactionType: "REPORT_COMPLETION",
        resourceId: "r1",
        resourceType: "REPORT",
        idempotencyKey: "report_completion:r1",
        metadata: { ruleId: "rule-1", reportCompletionPoints: 10 },
      },
    ]);
  });

  it("credits nothing when the rate is 0", () => {
    expect(resolveReportCompletionCredits({ reportId: "r1", userId: "u1" }, rules(0))).toEqual([]);
  });

  it("ignores points sent by a legacy payload", () => {
    const payload = new ReportCompletionGreenPointStrategy().validatePayload({
      reportId: "r1",
      userId: "u1",
      points: 999,
    });
    expect(resolveReportCompletionCredits(payload, rules(10))[0].points).toBe(10);
  });
});
