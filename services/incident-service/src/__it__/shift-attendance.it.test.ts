/**
 * Attendance per shift (Đặc tả luồng chiến dịch-8, 4.1), against a real Postgres.
 *
 *   - the leader opens a QR session; the code changes every period and an old one is refused
 *   - a scan farther than 50 m or with a poor GPS is recorded, flagged and logged; a manager may
 *     exclude it from the points (and restore it)
 *   - the first scan checks in, a later one checks out; closing the session checks everyone out
 *   - whoever runs the shift cannot check in on it; someone not registered can, flagged
 *   - manual attendance is limited to 20% of those present; a late (offline) scan is flagged
 *   - points: a share of the tier's points per eligible shift (60%, with a check-out)
 *
 * identity is mocked; the DB is real. Time is passed to the service.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "it-shift-attendance-secret";

jest.mock("../modules/organization/identity-user.client", () => ({
  fetchOrganizationOwnersByUserIds: async () => new Map(),
  getUserProfile: () => undefined,
}));

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { CampaignStatus } from "@da2/constants";
import { prisma } from "./setup/test-db";
import { shiftAttendanceService as svc } from "../modules/campaign/campaign_attendance/shift-attendance.service";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const OWNER = randomUUID();
const LEADER = randomUUID();
const MGR = randomUUID();
const V1 = randomUUID();
const V2 = randomUUID();
const V3 = randomUUID();
const POINT = { latitude: 10.77, longitude: 106.7 };
const HERE = { latitude: POINT.latitude + 0.0002, longitude: POINT.longitude, accuracy: 10 };

const code = (c: string) => ({ statusResponse: expect.objectContaining({ code: c }) });

/** Shift A (led by LEADER) and B, 4 hours each, from `start`; V1 registered on both. */
async function seed(start: Date) {
  const org = await prisma.organization.create({
    data: {
      name: `Org ${randomUUID()}`,
      slug: `org-${randomUUID()}`,
      logoUrl: "https://example.com/logo.png",
      status: 1,
      members: {
        create: [
          { userId: OWNER, role: "OWNER", source: "INTERNAL" },
          { userId: LEADER, role: "CAMPAIGN_MANAGER", source: "INTERNAL" },
          { userId: MGR, role: "CAMPAIGN_MANAGER", source: "INTERNAL" },
        ],
      },
    },
  });
  const end = new Date(start.getTime() + 4 * HOUR);
  const campaign = await prisma.campaign.create({
    data: {
      title: "Dọn rác kênh",
      status: CampaignStatus.ACTIVE,
      organizationId: org.id,
      createdBy: OWNER,
      latitude: POINT.latitude,
      longitude: POINT.longitude,
      campaignManagers: {
        create: [
          { userId: OWNER, assignedBy: OWNER },
          { userId: LEADER, assignedBy: OWNER },
          { userId: MGR, assignedBy: OWNER },
        ],
      },
    },
  });
  const day = await prisma.campaignDay.create({ data: { campaignId: campaign.id, startAt: start, endAt: end } });
  const [pa, pb] = await Promise.all(
    [0, 1].map((i) =>
      prisma.campaignMeetingPoint.create({
        data: { campaignId: campaign.id, ...POINT, longitude: POINT.longitude + i * 0.01, radiusKm: 1, sortOrder: i },
      }),
    ),
  );
  const shift = (meetingPointId: string, leaderUserId: string) =>
    prisma.campaignShift.create({
      data: { campaignId: campaign.id, dayId: day.id, meetingPointId, startAt: start, endAt: end, minVolunteers: 5, leaderUserId },
    });
  const a = await shift(pa.id, LEADER);
  const b = await shift(pb.id, MGR);
  await prisma.campaignShiftRegistration.createMany({
    data: [a, b].map((s) => ({ campaignId: campaign.id, shiftId: s.id, userId: V1 })),
  });
  return { id: campaign.id, a, b };
}

const at = (base: Date, ms: number) => new Date(base.getTime() + ms);

/** Opens (or reuses) the session as LEADER and returns a code made at `when`. */
async function codeAt(campaignId: string, shiftId: string, when: Date, by = LEADER) {
  await svc.openSession(campaignId, shiftId, by, when);
  return (await svc.issueQr(campaignId, shiftId, by, when)).token;
}

const scan = (campaignId: string, userId: string, token: string, now: Date, extra: object = {}) =>
  svc.scan(campaignId, userId, { token, ...HERE, ...extra }, now);

let start: Date;

beforeEach(async () => {
  await prisma.$executeRaw(
    Prisma.sql`TRUNCATE TABLE "organizations", "campaigns" RESTART IDENTITY CASCADE`,
  );
  start = new Date(Date.now() - HOUR);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("scanning", () => {
  it("checks in, ignores a quick second scan, checks out later; eligible at 60%", async () => {
    const c = await seed(start);
    const t = at(start, 10 * MIN);
    const first = await scan(c.id, V1, await codeAt(c.id, c.a.id, t), at(t, 5000));
    expect(first).toMatchObject({ action: "check_in", eligible: false });
    const row = await prisma.campaignShiftAttendance.findUniqueOrThrow({
      where: { shiftId_userId: { shiftId: c.a.id, userId: V1 } },
    });
    expect(row).toMatchObject({ preRegistered: true, offline: false, manual: false });

    const t2 = at(t, 5 * MIN);
    expect((await scan(c.id, V1, await codeAt(c.id, c.a.id, t2), t2)).action).toBe("already_checked_in");

    // The first session has run out after an hour; the leader opens another for check-outs.
    const t3 = at(start, 3 * HOUR);
    const out = await scan(c.id, V1, await codeAt(c.id, c.a.id, t3), t3);
    expect(out).toMatchObject({ action: "check_out", eligible: true });
    expect((await scan(c.id, V1, await codeAt(c.id, c.a.id, at(t3, MIN)), at(t3, MIN))).action).toBe(
      "already_checked_out",
    );
  });

  it("refuses a code older than two periods, a code of another campaign, and no open session", async () => {
    const c = await seed(start);
    const t = at(start, 10 * MIN);
    const token = await codeAt(c.id, c.a.id, t);
    await expect(scan(c.id, V1, token, at(t, 21 * MIN))).rejects.toMatchObject(code("ATTENDANCE_QR_INVALID"));
    await expect(scan(randomUUID(), V1, token, t)).rejects.toMatchObject(code("ATTENDANCE_QR_INVALID"));
    await expect(svc.issueQr(c.id, c.b.id, MGR, t)).rejects.toMatchObject(code("ATTENDANCE_NOT_OPEN"));
  });

  it("a scan far away or with a poor GPS is recorded, flagged and logged", async () => {
    const c = await seed(start);
    const t = at(start, 10 * MIN);
    const token = await codeAt(c.id, c.a.id, t);
    const far = await scan(c.id, V1, token, t, { latitude: POINT.latitude + 0.001 });
    expect(far).toMatchObject({ action: "check_in", flags: { outOfArea: true, lowAccuracy: false } });
    expect(far.flags.distanceM).toBeGreaterThan(100);
    const blurry = await scan(c.id, V2, token, t, { accuracy: 80 });
    expect(blurry.flags).toMatchObject({ outOfArea: false, lowAccuracy: true });

    const rows = await prisma.campaignShiftAttendance.findMany({ where: { shiftId: c.a.id } });
    expect(rows.find((r) => r.userId === V1)).toMatchObject({ outOfArea: true });
    expect(rows.find((r) => r.userId === V1)?.checkInDistanceM).toBeGreaterThan(100);
    expect(await prisma.campaignStatusLog.count({ where: { campaignId: c.id, event: "attendance_flagged" } })).toBe(2);
    const view = await svc.listForShift(c.id, c.a.id, { userId: LEADER }, t);
    expect(view.flagged).toBe(2);
  });

  it("a manager excludes a flagged attendance from the points and may restore it", async () => {
    const c = await seed(start);
    const t = at(start, 10 * MIN);
    await scan(c.id, V2, await codeAt(c.id, c.a.id, t), t, { latitude: POINT.latitude + 0.002 });
    await svc.closeSession(c.id, c.a.id, LEADER, at(start, 3 * HOUR));
    expect(await svc.completionCredits(c.id, 10)).toEqual([{ userId: V2, points: 10 }]);

    await expect(
      svc.setExcluded(c.id, c.a.id, V2, V1, { reason: "Không có mặt" }),
    ).rejects.toMatchObject(code("CAMPAIGN_PERMISSION_DENIED"));
    await svc.setExcluded(c.id, c.a.id, V2, LEADER, { reason: "Không có mặt" });
    expect(await svc.completionCredits(c.id, 10)).toEqual([]);
    const excluded = (await svc.listForShift(c.id, c.a.id, { userId: LEADER })).attendances[0];
    expect(excluded).toMatchObject({ excluded: true, excludeReason: "Không có mặt", eligible: false });

    await svc.setExcluded(c.id, c.a.id, V2, MGR, null);
    expect(await svc.completionCredits(c.id, 10)).toEqual([{ userId: V2, points: 10 }]);
    expect(
      await prisma.campaignStatusLog.count({
        where: { campaignId: c.id, event: { in: ["attendance_excluded", "attendance_restored"] } },
      }),
    ).toBe(2);
  });

  it("whoever runs the shift cannot check in on it; another manager and a walk-in can", async () => {
    const c = await seed(start);
    const t = at(start, 10 * MIN);
    const token = await codeAt(c.id, c.a.id, t);
    await expect(scan(c.id, LEADER, token, t)).rejects.toMatchObject(code("ATTENDANCE_SELF_CHECK_IN"));
    expect((await scan(c.id, MGR, token, t)).action).toBe("check_in");
    await scan(c.id, V2, token, t);
    const walkIn = await prisma.campaignShiftAttendance.findUniqueOrThrow({
      where: { shiftId_userId: { shiftId: c.a.id, userId: V2 } },
    });
    expect(walkIn.preRegistered).toBe(false);
  });

  it("a scan synced later counts at the time it was made, flagged offline", async () => {
    const c = await seed(start);
    const t = at(start, 10 * MIN);
    const token = await codeAt(c.id, c.a.id, t);
    const res = await svc.scan(c.id, V1, { token, ...HERE, scannedAt: at(t, 5000) }, at(t, 2 * HOUR));
    expect(res.action).toBe("check_in");
    const row = await prisma.campaignShiftAttendance.findUniqueOrThrow({
      where: { shiftId_userId: { shiftId: c.a.id, userId: V1 } },
    });
    expect(row.offline).toBe(true);
    expect(row.checkInAt).toEqual(at(t, 5000));
  });
});

describe("closing and manual attendance", () => {
  it("closing checks everyone out; the session's codes stop working", async () => {
    const c = await seed(start);
    const t = at(start, 10 * MIN);
    const token = await codeAt(c.id, c.a.id, t);
    await scan(c.id, V1, token, t);
    await scan(c.id, V2, token, t);
    const closedAt = at(start, 3 * HOUR);
    expect(await svc.closeSession(c.id, c.a.id, LEADER, closedAt)).toEqual({ checkedOut: 2 });
    const view = await svc.listForShift(c.id, c.a.id, { userId: LEADER }, closedAt);
    expect(view).toMatchObject({ present: 2, eligible: 2, session: null });
    expect(view.attendances.every((a) => a.checkOutMethod === "session_close")).toBe(true);
    // No code after closing; a code from before is refused once scanned after the close.
    await expect(svc.issueQr(c.id, c.a.id, LEADER, at(closedAt, 1000))).rejects.toMatchObject(
      code("ATTENDANCE_NOT_OPEN"),
    );
    const before = at(start, 2 * HOUR);
    await svc.openSession(c.id, c.b.id, MGR, before);
    const tokenB = (await svc.issueQr(c.id, c.b.id, MGR, before)).token;
    await svc.closeSession(c.id, c.b.id, MGR, at(before, 1000));
    await expect(scan(c.id, V3, tokenB, at(before, 5000))).rejects.toMatchObject(
      code("ATTENDANCE_NOT_OPEN"),
    );
  });

  it("is limited to 20% of those present (at least one), never for oneself", async () => {
    const c = await seed(start);
    const t = at(start, 10 * MIN);
    await scan(c.id, V1, await codeAt(c.id, c.a.id, t), t);
    await expect(
      svc.addManual(c.id, c.a.id, LEADER, { userId: LEADER, reason: "Hết pin" }, t),
    ).rejects.toMatchObject(code("ATTENDANCE_SELF_CHECK_IN"));
    await svc.addManual(c.id, c.a.id, LEADER, { userId: V2, reason: "Hết pin" }, t);
    await expect(
      svc.addManual(c.id, c.a.id, LEADER, { userId: V3, reason: "Hỏng máy" }, t),
    ).rejects.toMatchObject(code("ATTENDANCE_MANUAL_LIMIT"));
    await expect(
      svc.addManual(c.id, c.a.id, LEADER, { userId: V2, reason: "Lại" }, t),
    ).rejects.toMatchObject(code("ATTENDANCE_ALREADY_RECORDED"));
    const log = await prisma.campaignStatusLog.findFirstOrThrow({ where: { event: "manual_attendance" } });
    expect(log).toMatchObject({ actorId: LEADER, reason: "Hết pin" });
  });
});

describe("points at completion", () => {
  it("share of registered shifts attended long enough; nothing without a check-out", async () => {
    const c = await seed(start);
    const t = at(start, 10 * MIN);
    const token = await codeAt(c.id, c.a.id, t);
    await scan(c.id, V1, token, t);
    await scan(c.id, V2, token, t);
    await scan(c.id, V3, token, t);
    const t3 = at(start, 3 * HOUR);
    const later = await codeAt(c.id, c.a.id, t3);
    await scan(c.id, V1, later, t3);
    await scan(c.id, V2, later, t3);
    // V3 never checks out.

    const credits = await svc.completionCredits(c.id, 10);
    expect(credits.sort((x, y) => x.points - y.points)).toEqual([
      { userId: V1, points: 5 }, // 1 of 2 registered shifts
      { userId: V2, points: 10 }, // walked in: 100%
    ]);
  });
});
