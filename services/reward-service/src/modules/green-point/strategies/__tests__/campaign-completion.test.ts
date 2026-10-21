import type { PointRulesSnapshot } from "../../../gamification/gamification-config.service";
import {
  CampaignCompletionGreenPointStrategy,
  resolveCampaignCompletionCredits,
} from "../campaign-completion-green-point.strategy";

const rules = (campaignCompletionPoints: number): PointRulesSnapshot => ({
  id: "rule-1",
  campaignCompletionPoints,
  baseReportPoint: 5,
  reportMilestoneThresholds: [1, 2, 5, 10],
  reportCompletionPoints: 0,
  pointExpirationDays: 90,
});

const points = (eligibleShifts: number, registeredShifts: number, rate = 20) =>
  resolveCampaignCompletionCredits(
    { campaignId: "c1", participants: [{ userId: "u1", eligibleShifts, registeredShifts }] },
    rules(rate),
  ).map((c) => c.points);

describe("resolveCampaignCompletionCredits", () => {
  it.each([
    [3, 3, 20, [20]],
    [2, 3, 20, [13]],
    [3, 2, 20, [20]], // capped at 100%
    [1, 0, 20, [20]], // only unregistered shifts
    [2, 3, 60, [40]],
    [2, 3, 0, []], // rate 0 turns the source off
  ])("eligible %i / registered %i at %i → %j", (e, r, rate, expected) => {
    expect(points(e, r, rate)).toEqual(expected);
  });

  it("records the rule and inputs on each credit", () => {
    const [credit] = resolveCampaignCompletionCredits(
      { campaignId: "c1", participants: [{ userId: "u1", eligibleShifts: 2, registeredShifts: 3 }] },
      rules(20),
    );
    expect(credit).toMatchObject({
      userId: "u1",
      resourceId: "c1",
      resourceType: "CAMPAIGN",
      transactionType: "CAMPAIGN_COMPLETION",
      idempotencyKey: "campaign_completion:c1",
      metadata: { ruleId: "rule-1", campaignCompletionPoints: 20, eligibleShifts: 2, registeredShifts: 3 },
    });
  });

  it("keeps the points of a legacy payload without reading rules", () => {
    const credits = resolveCampaignCompletionCredits(
      { campaignId: "c1", credits: [{ userId: "u1", points: 13 }, { userId: "u2", points: 0 }] },
      null,
    );
    expect(credits.map((c) => [c.userId, c.points, c.metadata])).toEqual([
      ["u1", 13, { legacyPayload: true }],
    ]);
  });

  it("credits nothing for the new payload when there are no rules", () => {
    expect(
      resolveCampaignCompletionCredits(
        { campaignId: "c1", participants: [{ userId: "u1", eligibleShifts: 1, registeredShifts: 1 }] },
        null,
      ),
    ).toEqual([]);
  });
});

describe("CampaignCompletionGreenPointStrategy.validatePayload", () => {
  const strategy = new CampaignCompletionGreenPointStrategy();

  it("accepts the new and the legacy shape", () => {
    expect(() =>
      strategy.validatePayload({ campaignId: "c1", participants: [{ userId: "u1", eligibleShifts: 1, registeredShifts: 0 }] }),
    ).not.toThrow();
    expect(() => strategy.validatePayload({ campaignId: "c1", credits: [{ userId: "u1", points: 5 }] })).not.toThrow();
  });

  it("rejects a payload with neither participants nor credits", () => {
    expect(() => strategy.validatePayload({ campaignId: "c1" })).toThrow();
  });

  it("rejects a participant without an eligible shift", () => {
    expect(() =>
      strategy.validatePayload({ campaignId: "c1", participants: [{ userId: "u1", eligibleShifts: 0, registeredShifts: 1 }] }),
    ).toThrow();
  });
});
