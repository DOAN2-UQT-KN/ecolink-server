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
const DAY = 24 * HOUR;
const LEADER = "leader-1";
const BASE = { latitude: 10.77, longitude: 106.7 };

/** An active shift on day `d` at point `p`, gathering half an hour before the day starts. */
function shift(d: number, p: number, minVolunteers = 10, day = START, maxVolunteers: number | null = null) {
  return {
    dayIndex: d,
    meetingPointIndex: p,
    gatherAt: new Date(day.getTime() - HOUR / 2),
    minVolunteers,
    maxVolunteers,
    leaderUserId: LEADER,
  };
}

/** Day `n` days after START, same hours. */
const dayAfter = (n: number) => ({
  startAt: new Date(START.getTime() + n * DAY),
  endAt: new Date(END.getTime() + n * DAY),
});

function input(overrides: Partial<SubmitCampaignInput> = {}): SubmitCampaignInput {
  return {
    title: "Dọn rác kênh Nhiêu Lộc",
    description: "<p>" + "Cùng nhau dọn sạch bờ kênh. ".repeat(6) + "</p>",
    banner: "https://example.com/banner.jpg",
    days: [{ startAt: START, endAt: END }],
    contactName: "Nguyễn Văn A",
    contactPhone: "0901234567",
    difficulty: 1,
    requirements: null,
    meetingPoints: [
      {
        ...BASE,
        radiusKm: 1,
        reportIds: ["r1"],
      },
    ],
    shifts: [shift(0, 0)],
    ...overrides,
  };
}

function ctx(overrides: Partial<SubmitValidationContext> = {}): SubmitValidationContext {
  return {
    now: NOW,
    suggestedMinPerDay: 5,
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
      codes(
        input({
          days: [{ startAt: soon, endAt: new Date(soon.getTime() + HOUR) }],
          shifts: [{ ...shift(0, 0), gatherAt: null }],
        }),
      ),
    ).toContain("START_TOO_SOON");
  });

  it("requires each day to end after it starts, within 12 hours, on the same local date", () => {
    expect(codes(input({ days: [{ startAt: START, endAt: START }] }))).toContain(
      "END_BEFORE_START",
    );
    expect(
      codes(input({ days: [{ startAt: START, endAt: new Date(START.getTime() + 13 * HOUR) }] })),
    ).toContain("TOO_LONG");
    // 22:00 → 02:00 local: 4 hours but across midnight
    const late = new Date("2026-10-05T15:00:00.000Z");
    expect(
      codes(
        input({
          days: [{ startAt: late, endAt: new Date(late.getTime() + 4 * HOUR) }],
          shifts: [{ ...shift(0, 0), gatherAt: null }],
        }),
      ),
    ).toContain("MULTI_DAY_UNSUPPORTED");
  });

  it("runs on 1–7 distinct days within 14 days of the first", () => {
    expect(codes(input({ days: [], shifts: [] }))).toContain("DAY_COUNT");
    const eight = Array.from({ length: 8 }, (_, i) => dayAfter(i));
    expect(
      codes(input({ days: eight, shifts: eight.map((d, i) => shift(i, 0, 10, d.startAt)) })),
    ).toContain("DAY_COUNT");
    expect(
      codes(input({ days: [dayAfter(0), dayAfter(0)], shifts: [shift(0, 0), shift(1, 0)] })),
    ).toContain("DAY_DUPLICATED");
    // Day 1 and day 14 are fine (not consecutive is fine too); day 15 is not.
    const ok = [dayAfter(0), dayAfter(13)];
    expect(
      codes(input({ days: ok, shifts: ok.map((d, i) => shift(i, 0, 10, d.startAt)) })),
    ).toEqual([]);
    const tooWide = [dayAfter(0), dayAfter(14)];
    expect(
      codes(input({ days: tooWide, shifts: tooWide.map((d, i) => shift(i, 0, 10, d.startAt)) })),
    ).toContain("DAY_SPAN_TOO_WIDE");
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

  describe("shifts (day × meeting point)", () => {
    const mp = { ...BASE, radiusKm: 1, reportIds: [] as string[] };
    const twoPoints = [
      { ...mp, name: "Đầu kênh Bắc" },
      { ...mp, name: "Đầu kênh Nam" },
    ];
    const twoDays = [dayAfter(0), dayAfter(1)];

    it("accepts the spec example: 15 (max 25) + 10 on day 1, 20 (max 30) + off on day 2", () => {
      const issues = validateCampaignForSubmit(
        input({
          days: twoDays,
          meetingPoints: twoPoints,
          shifts: [
            shift(0, 0, 15, START, 25),
            shift(0, 1, 10),
            shift(1, 0, 20, twoDays[1].startAt, 30),
            { ...shift(1, 1, 0), gatherAt: null, leaderUserId: null },
          ],
        }),
        ctx({ suggestedMinPerDay: 20 }),
      );
      expect(issues).toEqual([]);
    });

    it("never caps the number of volunteers: totals above the suggestion are fine", () => {
      expect(
        codes(input({ shifts: [shift(0, 0, 500)] }), ctx({ suggestedMinPerDay: 10 })),
      ).toEqual([]);
    });

    it("a day below the suggested minimum needs a reason", () => {
      const low = input({
        days: twoDays,
        meetingPoints: twoPoints,
        shifts: [shift(0, 0, 3), shift(0, 1, 2), shift(1, 0, 20, twoDays[1].startAt)],
      });
      const issues = validateCampaignForSubmit(low, ctx({ suggestedMinPerDay: 10 }));
      expect(issues).toContainEqual(
        expect.objectContaining({
          field: "minVolunteersReason",
          code: "MIN_VOLUNTEERS_REASON_REQUIRED",
        }),
      );
      expect(
        codes({ ...low, minVolunteersReason: "Small canal, 5 people are enough" }, ctx({ suggestedMinPerDay: 10 })),
      ).toEqual([]);
      expect(codes(low, ctx({ suggestedMinPerDay: null }))).toEqual([]);
    });

    it("the expected maximum, when set, is a whole number no lower than the minimum", () => {
      const issues = validateCampaignForSubmit(
        input({ shifts: [shift(0, 0, 10, START, 8)] }),
        ctx(),
      );
      expect(issues).toContainEqual(
        expect.objectContaining({ field: "schedule[0][0].maxVolunteers", code: "MAX_BELOW_MIN" }),
      );
      expect(codes(input({ shifts: [shift(0, 0, 10, START, 10)] }))).toEqual([]);
    });

    it("needs an active shift on every day; missing shifts are off", () => {
      const issues = validateCampaignForSubmit(
        input({ days: twoDays, meetingPoints: twoPoints, shifts: [shift(0, 0)] }),
        ctx(),
      );
      expect(issues).toContainEqual(
        expect.objectContaining({ field: "days[1]", code: "DAY_NO_ACTIVE_SHIFT" }),
      );
    });

    it("rejects a negative or fractional minimum", () => {
      expect(codes(input({ shifts: [shift(0, 0, -1)] }))).toContain("MIN_VOLUNTEERS_INVALID");
      expect(codes(input({ shifts: [shift(0, 0, 2.5)] }))).toContain("MIN_VOLUNTEERS_INVALID");
    });

    it("an active shift needs an eligible leader; an off one does not", () => {
      const issues = validateCampaignForSubmit(
        input({ shifts: [{ ...shift(0, 0), leaderUserId: "stranger" }] }),
        ctx(),
      );
      expect(issues).toContainEqual(
        expect.objectContaining({ field: "schedule[0][0].leaderUserId", code: "LEADER_INVALID" }),
      );
      expect(
        codes(
          input({
            meetingPoints: twoPoints,
            shifts: [shift(0, 0), { ...shift(0, 1, 0), leaderUserId: "stranger" }],
          }),
        ),
      ).toEqual([]);
    });

    it("keeps the gathering time on the shift's day, before it ends", () => {
      expect(
        codes(input({ shifts: [{ ...shift(0, 0), gatherAt: new Date(END.getTime() + HOUR) }] })),
      ).toContain("GATHER_TIME_INVALID");
      expect(
        codes(
          input({
            days: twoDays,
            shifts: [shift(0, 0), { ...shift(1, 0), gatherAt: new Date(START.getTime()) }],
          }),
        ),
      ).toContain("GATHER_TIME_INVALID");
    });

    it("gathers no later than the shift starts", () => {
      const startAt = new Date(START.getTime() + HOUR);
      expect(
        codes(input({ shifts: [{ ...shift(0, 0), startAt, gatherAt: new Date(START.getTime() + 2 * HOUR) }] })),
      ).toContain("GATHER_TIME_INVALID");
      expect(
        codes(input({ shifts: [{ ...shift(0, 0), startAt, gatherAt: new Date(START.getTime() + 30 * 60 * 1000) }] })),
      ).toEqual([]);
    });

    it("keeps a shift's window inside its day, start before end", () => {
      expect(codes(input({ shifts: [{ ...shift(0, 0), startAt: new Date(START.getTime() + HOUR) }] }))).toEqual([]);
      expect(
        codes(input({ shifts: [{ ...shift(0, 0), startAt: new Date(START.getTime() - HOUR) }] })),
      ).toContain("SHIFT_TIME_INVALID");
      expect(
        codes(input({ shifts: [{ ...shift(0, 0), endAt: new Date(END.getTime() + HOUR) }] })),
      ).toContain("SHIFT_TIME_INVALID");
      expect(
        codes(input({ shifts: [{ ...shift(0, 0), startAt: new Date(START.getTime() + HOUR), endAt: new Date(START.getTime() + HOUR) }] })),
      ).toContain("SHIFT_TIME_INVALID");
    });
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
