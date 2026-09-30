import {
  haversineKm,
  stripHtml,
  validateCampaignForSubmit,
  withDefaultRequirements,
  type SubmitCampaignInput,
  type SubmitValidationContext,
} from "../campaign-submit-validation";
import { CAMPAIGN_REPORTS_REQUIRED } from "@da2/constants";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-10-01T01:00:00.000Z"); // 08:00 in Vietnam
// 07:00–11:00 local on 2026-10-05
const START = new Date("2026-10-05T00:00:00.000Z");
const END = new Date("2026-10-05T04:00:00.000Z");
const LEADER = "leader-1";
const BASE = { latitude: 10.77, longitude: 106.7 };

function input(overrides: Partial<SubmitCampaignInput> = {}): SubmitCampaignInput {
  return {
    title: "Dọn rác kênh Nhiêu Lộc",
    description: "<p>" + "Cùng nhau dọn sạch bờ kênh. ".repeat(6) + "</p>",
    banner: "https://example.com/banner.jpg",
    startDate: START,
    endDate: END,
    contactName: "Nguyễn Văn A",
    contactPhone: "0901234567",
    difficulty: 1,
    requirements: null,
    meetingPoints: [
      {
        ...BASE,
        radiusKm: 1,
        gatherAt: new Date(START.getTime() - HOUR / 2),
        slots: 10,
        leaderUserId: LEADER,
        reportIds: ["r1"],
      },
    ],
    ...overrides,
  };
}

function ctx(overrides: Partial<SubmitValidationContext> = {}): SubmitValidationContext {
  return {
    now: NOW,
    maxVolunteers: 20,
    maxDifficulty: null,
    reports: new Map([
      ["r1", { latitude: 10.771, longitude: 106.701 }],
      ["r2", { latitude: 10.772, longitude: 106.702 }],
      ["far", { latitude: 10.9, longitude: 106.7 }],
    ]),
    eligibleLeaderIds: new Set([LEADER]),
    ...overrides,
  };
}

const codes = (i: SubmitCampaignInput, c: SubmitValidationContext = ctx()) =>
  validateCampaignForSubmit(i, c).map((x) => x.code);

describe("validateCampaignForSubmit", () => {
  it("accepts a complete campaign", () => {
    expect(validateCampaignForSubmit(input(), ctx())).toEqual([]);
  });

  it("checks title, description (plain text) and banner", () => {
    expect(codes(input({ title: "Short" }))).toContain("TITLE_LENGTH");
    expect(codes(input({ title: "x".repeat(121) }))).toContain("TITLE_LENGTH");
    expect(codes(input({ description: "<p>" + "<b></b>".repeat(200) + "short</p>" }))).toContain(
      "DESCRIPTION_TOO_SHORT",
    );
    expect(codes(input({ banner: null }))).toContain("BANNER_REQUIRED");
  });

  it("requires 48 hours of lead time", () => {
    const soon = new Date(NOW.getTime() + 47 * HOUR);
    expect(
      codes(input({ startDate: soon, endDate: new Date(soon.getTime() + HOUR) })),
    ).toContain("START_TOO_SOON");
  });

  it("requires end after start, at most 12 hours, same local day", () => {
    expect(codes(input({ endDate: START }))).toContain("END_BEFORE_START");
    expect(codes(input({ endDate: new Date(START.getTime() + 13 * HOUR) }))).toContain(
      "TOO_LONG",
    );
    // 22:00 → 02:00 local: 4 hours but across midnight
    const late = new Date("2026-10-05T15:00:00.000Z");
    expect(
      codes(
        input({
          startDate: late,
          endDate: new Date(late.getTime() + 4 * HOUR),
          meetingPoints: [{ ...input().meetingPoints[0], gatherAt: null }],
        }),
      ),
    ).toContain("MULTI_DAY_UNSUPPORTED");
  });

  it("requires a contact and a valid phone", () => {
    expect(codes(input({ contactName: " " }))).toContain("CONTACT_NAME_REQUIRED");
    expect(codes(input({ contactPhone: "12345" }))).toContain("CONTACT_PHONE_INVALID");
    expect(codes(input({ contactPhone: "+84 901 234 567" }))).not.toContain(
      "CONTACT_PHONE_INVALID",
    );
  });

  it("limits unverified organizations to the lowest difficulty", () => {
    expect(codes(input({ difficulty: 2 }), ctx({ maxDifficulty: 1 }))).toContain(
      "DIFFICULTY_NOT_ALLOWED",
    );
  });

  it("needs 1–5 meeting points", () => {
    expect(codes(input({ meetingPoints: [] }))).toContain("MEETING_POINT_COUNT");
    const six = Array.from({ length: 6 }, () => ({ ...input().meetingPoints[0], name: "P", reportIds: [] }));
    expect(codes(input({ meetingPoints: six }))).toContain("MEETING_POINT_COUNT");
  });

  it("waste points are optional while CAMPAIGN_REPORTS_REQUIRED is off", () => {
    expect(CAMPAIGN_REPORTS_REQUIRED).toBe(false);
    expect(
      codes(input({ meetingPoints: [{ ...input().meetingPoints[0], reportIds: [] }] })),
    ).toEqual([]);
  });

  it("checks waste points: available, inside the radius, one meeting point each", () => {
    const mp = input().meetingPoints[0];
    expect(codes(input({ meetingPoints: [{ ...mp, reportIds: ["gone"] }] }))).toContain(
      "REPORT_UNAVAILABLE",
    );
    expect(codes(input({ meetingPoints: [{ ...mp, reportIds: ["far"] }] }))).toContain(
      "REPORT_OUTSIDE_RADIUS",
    );
    const second = { ...mp, name: "B", reportIds: ["r1"] };
    expect(
      codes(input({ meetingPoints: [{ ...mp, name: "A" }, second] })),
    ).toContain("REPORT_DUPLICATED");
  });

  it("names points only when there are several, and keeps them within 5 km", () => {
    const mp = input().meetingPoints[0];
    expect(
      codes(input({ meetingPoints: [mp, { ...mp, reportIds: ["r2"] }] })),
    ).toContain("MEETING_POINT_NAME_REQUIRED");
    const far = { ...mp, name: "Far", latitude: 10.9, reportIds: ["far"] };
    expect(codes(input({ meetingPoints: [{ ...mp, name: "A" }, far] }))).toContain(
      "MEETING_POINTS_TOO_FAR",
    );
  });

  it("caps the total slots at the difficulty's volunteer limit", () => {
    const mp = input().meetingPoints[0];
    const points = [
      { ...mp, name: "A", slots: 15 },
      { ...mp, name: "B", slots: 10, reportIds: ["r2"] },
    ];
    expect(codes(input({ meetingPoints: points }))).toContain("SLOTS_OVER_LIMIT");
    expect(codes(input({ meetingPoints: points }), ctx({ maxVolunteers: null }))).not.toContain(
      "SLOTS_OVER_LIMIT",
    );
  });

  it("requires a leader who is an eligible member", () => {
    const mp = input().meetingPoints[0];
    expect(codes(input({ meetingPoints: [{ ...mp, leaderUserId: "stranger" }] }))).toContain(
      "LEADER_INVALID",
    );
  });

  it("keeps the gathering time on the campaign day", () => {
    const mp = input().meetingPoints[0];
    expect(
      codes(input({ meetingPoints: [{ ...mp, gatherAt: new Date(END.getTime() + HOUR) }] })),
    ).toContain("GATHER_TIME_INVALID");
  });
});

describe("helpers", () => {
  it("withDefaultRequirements sets 18+ for high difficulty", () => {
    expect(withDefaultRequirements(null, 3).minAge).toBe(18);
    expect(withDefaultRequirements({ minAge: 16 }, 4).minAge).toBe(18);
    expect(withDefaultRequirements({ minAge: 21 }, 3).minAge).toBe(21);
    expect(withDefaultRequirements(null, 1).minAge).toBeUndefined();
  });

  it("stripHtml and haversineKm", () => {
    expect(stripHtml("<p>Hello&nbsp;<b>world</b></p>")).toBe("Hello world");
    expect(haversineKm(BASE, { latitude: 10.815, longitude: 106.7 })).toBeCloseTo(5, 0);
  });
});
