import { isReportResourceType, mapResourceTypeToSourceType } from "../../../gamification/point-source.util";
import type { PointRulesSnapshot } from "../../../gamification/gamification-config.service";
import { resolveReportVoteMilestoneCredits } from "../report-vote-milestone-green-point.strategy";

const rules = (baseReportPoint: number, reportMilestoneThresholds: number[]): PointRulesSnapshot => ({
  id: "rule-1",
  campaignCompletionPoints: 20,
  baseReportPoint,
  reportMilestoneThresholds,
  reportCompletionPoints: 0,
});

const payout = (voteCount: number, r: PointRulesSnapshot) =>
  resolveReportVoteMilestoneCredits({ reportId: "r1", reportCreatorUserId: "u1", voteCount }, r).map(
    (c) => [c.resourceType, c.points],
  );

describe("resolveReportVoteMilestoneCredits", () => {
  it("pays base × index for every milestone reached", () => {
    expect(payout(5, rules(5, [1, 2, 5, 10]))).toEqual([
      ["REPORT_VOTE_MILESTONE_1", 5],
      ["REPORT_VOTE_MILESTONE_2", 10],
      ["REPORT_VOTE_MILESTONE_5", 15],
    ]);
  });

  it("indexes by the current (sorted) milestone list", () => {
    expect(payout(5, rules(5, [10, 5, 3, 2, 1]))).toEqual([
      ["REPORT_VOTE_MILESTONE_1", 5],
      ["REPORT_VOTE_MILESTONE_2", 10],
      ["REPORT_VOTE_MILESTONE_3", 15],
      ["REPORT_VOTE_MILESTONE_5", 20],
    ]);
  });

  it("pays nothing when the base is 0", () => {
    expect(payout(10, rules(0, [1, 2]))).toEqual([]);
  });
});

describe("report resource types", () => {
  it("treats milestones as report-sourced", () => {
    expect(isReportResourceType("REPORT")).toBe(true);
    expect(isReportResourceType("REPORT_VOTE_MILESTONE_5")).toBe(true);
    expect(isReportResourceType("CAMPAIGN")).toBe(false);
    expect(mapResourceTypeToSourceType("REPORT_VOTE_MILESTONE_5")).toBe("REPORT");
  });
});
