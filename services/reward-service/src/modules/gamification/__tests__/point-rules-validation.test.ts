import {
  normalizePointRulesInput,
  validatePointRulesInput,
} from "../gamification-config.service";

const valid = {
  campaignCompletionPoints: 20,
  baseReportPoint: 5,
  reportMilestoneThresholds: [1, 2, 5, 10],
  reportCompletionPoints: 0,
};
const fields = (body: Record<string, unknown>) => validatePointRulesInput(body).map((e) => e.field);

describe("validatePointRulesInput", () => {
  it("accepts valid rules, including no milestones", () => {
    expect(fields(valid)).toEqual([]);
    expect(fields({ ...valid, reportMilestoneThresholds: [] })).toEqual([]);
  });

  it.each([
    [{ campaignCompletionPoints: -1 }, "campaignCompletionPoints"],
    [{ baseReportPoint: 1.5 }, "baseReportPoint"],
    [{ reportCompletionPoints: "10" }, "reportCompletionPoints"],
    [{ reportMilestoneThresholds: [0, 2] }, "reportMilestoneThresholds"],
    [{ reportMilestoneThresholds: [2, 2] }, "reportMilestoneThresholds"],
    [{ reportMilestoneThresholds: "1,2" }, "reportMilestoneThresholds"],
  ])("rejects %j", (patch, field) => {
    expect(fields({ ...valid, ...patch })).toEqual([field]);
  });

  it("rejects missing fields", () => {
    expect(fields({})).toEqual([
      "campaignCompletionPoints",
      "baseReportPoint",
      "reportCompletionPoints",
      "reportMilestoneThresholds",
    ]);
  });
});

describe("normalizePointRulesInput", () => {
  it("stores milestones ascending", () => {
    expect(
      normalizePointRulesInput({ ...valid, reportMilestoneThresholds: [10, 2, 5, 1] }).reportMilestoneThresholds,
    ).toEqual([1, 2, 5, 10]);
  });
});
