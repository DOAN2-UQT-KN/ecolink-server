import type { PointRulesSnapshot } from "../../../gamification/gamification-config.service";
import { resolveReportVoteMilestoneCredits } from "../report-vote-milestone-green-point.strategy";

const rules = (baseReportPoint: number, reportMilestoneThresholds: number[]): PointRulesSnapshot => ({
  id: "rule-1",
  campaignCompletionPoints: 20,
  baseReportPoint,
  reportMilestoneThresholds,
  reportCompletionPoints: 0,
  pointExpirationDays: 90,
});

const payout = (voteCount: number, r: PointRulesSnapshot) =>
  resolveReportVoteMilestoneCredits({ reportId: "r1", reportCreatorUserId: "u1", voteCount }, r).map(
    (c) => [c.idempotencyKey, c.points],
  );

describe("resolveReportVoteMilestoneCredits", () => {
  it("pays base × index for every milestone reached", () => {
    expect(payout(5, rules(5, [1, 2, 5, 10]))).toEqual([
      ["vote_milestone:r1:1", 5],
      ["vote_milestone:r1:2", 10],
      ["vote_milestone:r1:5", 15],
    ]);
  });

  it("indexes by the current (sorted) milestone list", () => {
    expect(payout(5, rules(5, [10, 5, 3, 2, 1]))).toEqual([
      ["vote_milestone:r1:1", 5],
      ["vote_milestone:r1:2", 10],
      ["vote_milestone:r1:3", 15],
      ["vote_milestone:r1:5", 20],
    ]);
  });

  it("pays nothing when the base is 0", () => {
    expect(payout(10, rules(0, [1, 2]))).toEqual([]);
  });
});

describe("milestone ledger rows", () => {
  it("point at the report and carry the threshold in the key", () => {
    const [first] = resolveReportVoteMilestoneCredits(
      { reportId: "r1", reportCreatorUserId: "u1", voteCount: 1 },
      rules(5, [1]),
    );
    expect(first.resourceType).toBe("REPORT");
    expect(first.idempotencyKey).toBe("vote_milestone:r1:1");
  });
});
