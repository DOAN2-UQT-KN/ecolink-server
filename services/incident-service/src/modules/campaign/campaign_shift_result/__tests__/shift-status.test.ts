import { effectiveEnd, shiftStatusOf } from "../shift-status";
import { isEligible, presenceMs } from "../../campaign_attendance/shift-attendance.service";

jest.mock("../../../../config/prisma.client", () => ({ __esModule: true, default: {} }));

const H = 60 * 60 * 1000;
const start = new Date("2026-10-05T00:00:00Z");
const shift = { startAt: start, endAt: new Date(start.getTime() + 4 * H), endedAt: null as Date | null, minVolunteers: 3 };
const at = (h: number) => new Date(start.getTime() + h * H);

describe("shiftStatusOf", () => {
  it("is off when the shift is turned off", () => {
    expect(shiftStatusOf({ ...shift, minVolunteers: 0 }, false, at(1))).toBe("off");
  });
  it("goes upcoming → running → awaiting_result → ended", () => {
    expect(shiftStatusOf(shift, false, at(-1))).toBe("upcoming");
    expect(shiftStatusOf(shift, false, at(1))).toBe("running");
    expect(shiftStatusOf(shift, false, at(4))).toBe("awaiting_result");
    expect(shiftStatusOf(shift, true, at(4))).toBe("ended");
  });
  it("is awaiting_result again while the admin has reopened its result (spec 5.2)", () => {
    expect(shiftStatusOf(shift, { reopenedAt: at(5) }, at(6))).toBe("awaiting_result");
    expect(shiftStatusOf(shift, { reopenedAt: null }, at(6))).toBe("ended");
    expect(shiftStatusOf(shift, null, at(6))).toBe("awaiting_result");
  });
  it("ends at endedAt when ended early", () => {
    const early = { ...shift, endedAt: at(2) };
    expect(effectiveEnd(early)).toEqual(at(2));
    expect(shiftStatusOf(early, true, at(2.5))).toBe("ended");
  });
});

describe("presence after ending early", () => {
  it("counts until the actual end, and the 60% of the shortened shift", () => {
    const att = { checkInAt: at(0.25), checkOutAt: at(3) };
    expect(presenceMs(att, shift)).toBe(2.75 * H);
    const early = { ...shift, endedAt: at(2) };
    expect(presenceMs(att, early)).toBe(1.75 * H);
    expect(isEligible({ checkInAt: at(0.5), checkOutAt: at(2) }, shift)).toBe(false);
    expect(isEligible({ checkInAt: at(0.5), checkOutAt: at(2) }, early)).toBe(true);
  });
});
