import {
  normalizePointRulesInput,
  validatePointRulesInput,
} from "../gamification-config.service";

const valid = {
  campaignCompletionPoints: 20,
  baseReportPoint: 5,
  reportMilestoneThresholds: [1, 2, 5, 10],
  reportCompletionPoints: 0,
  pointExpirationDays: 90,
};
const fields = (body: Record<string, unknown>) => validatePointRulesInput(body).map((e) => e.field);

describe("validatePointRulesInput", () => {
  it("accepts valid rules, including no milestones", () => {
    expect(fields(valid)).toEqual([]);
    expect(fields({ ...valid, reportMilestoneThresholds: [] })).toEqual([]);
    expect(fields({ ...valid, pointExpirationDays: 1 })).toEqual([]);
    expect(fields({ ...valid, pointExpirationDays: 365 })).toEqual([]);
  });

  it.each([
    [{ campaignCompletionPoints: -1 }, "campaignCompletionPoints"],
    [{ baseReportPoint: 1.5 }, "baseReportPoint"],
    [{ reportCompletionPoints: "10" }, "reportCompletionPoints"],
    [{ reportMilestoneThresholds: [0, 2] }, "reportMilestoneThresholds"],
    [{ reportMilestoneThresholds: [2, 2] }, "reportMilestoneThresholds"],
    [{ reportMilestoneThresholds: "1,2" }, "reportMilestoneThresholds"],
    [{ pointExpirationDays: undefined }, "pointExpirationDays"],
    [{ pointExpirationDays: 0 }, "pointExpirationDays"],
    [{ pointExpirationDays: -5 }, "pointExpirationDays"],
    [{ pointExpirationDays: 1.5 }, "pointExpirationDays"],
    [{ pointExpirationDays: "90" }, "pointExpirationDays"],
  ])("rejects %j", (patch, field) => {
    expect(fields({ ...valid, ...patch })).toEqual([field]);
  });

  it("rejects missing fields", () => {
    expect(fields({})).toEqual([
      "campaignCompletionPoints",
      "baseReportPoint",
      "reportCompletionPoints",
      "pointExpirationDays",
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
