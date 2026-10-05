import {
  campaignDecision,
  failedReportsOf,
  meetingPointLayer1Level,
  nearestDistanceM,
  pointAfterVote,
  pointAtWindowEnd,
  tally,
  voteWeight,
} from "../verification-rules";

const NOW = new Date("2026-10-05T03:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const base = {
  isReporter: false,
  gpsDistanceM: null,
  gpsAccuracyM: null,
  savedLocationDistanceM: null,
  accountCreatedAt: new Date(NOW.getTime() - 30 * DAY),
  emailVerified: true,
  now: NOW,
};

describe("voteWeight", () => {
  it("weighs the reporter 10 wherever they are", () => {
    expect(voteWeight({ ...base, isReporter: true })).toEqual({ weight: 10, reason: "reporter" });
    expect(voteWeight({ ...base, isReporter: true, gpsDistanceM: 10 })).toEqual({ weight: 10, reason: "reporter" });
  });

  it("weighs live GPS within 30 m 3 (not with poor accuracy), within 5 km 1", () => {
    expect(voteWeight({ ...base, gpsDistanceM: 25, gpsAccuracyM: 10 })).toEqual({ weight: 3, reason: "on_site" });
    expect(voteWeight({ ...base, gpsDistanceM: 25, gpsAccuracyM: 200 })).toEqual({ weight: 1, reason: "nearby" });
    expect(voteWeight({ ...base, gpsDistanceM: 31 })).toEqual({ weight: 1, reason: "nearby" });
    expect(voteWeight({ ...base, gpsDistanceM: 4999 })).toEqual({ weight: 1, reason: "nearby" });
  });

  it("falls back to the saved location for nearby; far or unknown weighs 0", () => {
    expect(voteWeight({ ...base, savedLocationDistanceM: 3000 })).toEqual({ weight: 1, reason: "nearby" });
    expect(voteWeight({ ...base, gpsDistanceM: 8000, savedLocationDistanceM: 2000 })).toEqual({ weight: 1, reason: "nearby" });
    expect(voteWeight({ ...base, savedLocationDistanceM: 6000 })).toEqual({ weight: 0, reason: "zero_far" });
    expect(voteWeight(base)).toEqual({ weight: 0, reason: "zero_far" });
  });

  it("weighs 0 for accounts under 7 days or with an unverified email, the reporter too", () => {
    const young = { ...base, accountCreatedAt: new Date(NOW.getTime() - 6 * DAY) };
    expect(voteWeight({ ...young, isReporter: true })).toEqual({ weight: 0, reason: "zero_new_account" });
    expect(voteWeight({ ...base, emailVerified: false, gpsDistanceM: 5 })).toEqual({ weight: 0, reason: "zero_unverified" });
    expect(voteWeight({ ...base, accountCreatedAt: new Date(NOW.getTime() - 7 * DAY), gpsDistanceM: 5 }).weight).toBe(3);
  });
});

describe("point decision table", () => {
  it("tallies weights; only weighted downvotes count as a downvote", () => {
    expect(tally([{ value: 1, weight: 10 }, { value: 1, weight: 3 }, { value: -1, weight: 1 }])).toEqual({ score: 12, hasDownvote: true });
    expect(tally([{ value: -1, weight: 0 }])).toEqual({ score: 0, hasDownvote: false });
  });

  it("verifies at ≥ 15 at once (a flagged point too)", () => {
    expect(pointAfterVote({ status: "voting", score: 16, hasDownvote: false })).toEqual({ status: "verified", code: "score" });
    expect(pointAfterVote({ status: "voting", score: 15, hasDownvote: true })).toEqual({ status: "verified", code: "score" });
    expect(pointAfterVote({ status: "flagged", score: 15, hasDownvote: true })).toEqual({ status: "verified", code: "score" });
  });

  it("flags a voting point with a downvote and ≤ 3; otherwise waits", () => {
    expect(pointAfterVote({ status: "voting", score: 3, hasDownvote: true })).toEqual({ status: "flagged", code: null });
    expect(pointAfterVote({ status: "voting", score: -10, hasDownvote: true })?.status).toBe("flagged");
    expect(pointAfterVote({ status: "voting", score: 0, hasDownvote: false })).toBeNull();
    expect(pointAfterVote({ status: "voting", score: 4, hasDownvote: true })).toBeNull();
    expect(pointAfterVote({ status: "flagged", score: 0, hasDownvote: true })).toBeNull();
    expect(pointAfterVote({ status: "verified", score: 0, hasDownvote: true })).toBeNull();
  });

  it("at the window's end: a downvote flags; else Layer 1 decides", () => {
    expect(pointAtWindowEnd({ hasDownvote: true, layer1Level: "pass" })).toEqual({ status: "flagged", code: null });
    expect(pointAtWindowEnd({ hasDownvote: false, layer1Level: "pass" })).toEqual({ status: "verified", code: "layer1_pass" });
    expect(pointAtWindowEnd({ hasDownvote: false, layer1Level: "warn" })).toEqual({ status: "flagged", code: null });
    expect(pointAtWindowEnd({ hasDownvote: false, layer1Level: "fail" })).toEqual({ status: "rejected", code: "layer1_fail" });
  });
});

describe("campaign decision", () => {
  it("completes when every point is verified", () => {
    expect(campaignDecision(["verified", "verified"], 0)).toBe("complete");
  });
  it("waits while a point votes or is flagged, or when there is none", () => {
    expect(campaignDecision(["verified", "voting"], 0)).toBe("wait");
    expect(campaignDecision(["rejected", "flagged"], 0)).toBe("wait");
    expect(campaignDecision([], 0)).toBe("wait");
  });
  it("rejects with a rejected point and nothing left, up to 3 times; then the admin decides", () => {
    expect(campaignDecision(["verified", "rejected"], 0)).toBe("reject");
    expect(campaignDecision(["rejected"], 2)).toBe("reject");
    expect(campaignDecision(["rejected"], 3)).toBe("await_admin");
  });
});

describe("meeting point helpers", () => {
  const km = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) =>
    Math.abs(a.latitude - b.latitude) * 111;

  it("measures the nearest of the meeting point and its trash points", () => {
    const at = { latitude: 10, longitude: 106 };
    expect(nearestDistanceM(at, [{ latitude: 10.001, longitude: 106 }, { latitude: 10.0002, longitude: 106 }], km)).toBe(22);
    expect(nearestDistanceM(at, [null, undefined], km)).toBeNull();
  });

  it("grades the meeting point as the worst of its cleaned trash points", () => {
    expect(meetingPointLayer1Level(["pass", "warn"])).toBe("warn");
    expect(meetingPointLayer1Level(["pass", "fail", "warn"])).toBe("fail");
    expect(meetingPointLayer1Level(["pass"])).toBe("pass");
  });

  const round = {
    reportIds: ["a", "b", "c"],
    layer1: [
      { reportId: "a", level: "pass" },
      { reportId: "b", level: "fail" },
      { reportId: "c", level: "warn" },
    ],
  };

  it("failed trash points: Layer 1 fail, the ones that failed", () => {
    expect(failedReportsOf(round, [], "layer1_fail")).toEqual(["b"]);
  });

  it("failed trash points: flag timeout, the ones weighted downvotes named; else all", () => {
    const votes = [
      { value: -1, weight: 3, flaggedReportIds: ["c"] },
      { value: -1, weight: 0, flaggedReportIds: ["a"] },
      { value: 1, weight: 10, flaggedReportIds: [] },
    ];
    expect(failedReportsOf(round, votes, "flag_timeout")).toEqual(["c"]);
    expect(failedReportsOf(round, [{ value: -1, weight: 0, flaggedReportIds: ["a"] }], "flag_timeout")).toEqual(["a", "b", "c"]);
    expect(failedReportsOf(round, [], null)).toEqual(["a", "b", "c"]);
  });
});
