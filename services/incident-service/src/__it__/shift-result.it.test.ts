/**
 * Shift results and status (Đặc tả luồng chiến dịch-8, 4.2 and 5.1), against a real Postgres.
 *
 *   - a shift's status follows the clock and its result: upcoming, running, awaiting_result, ended
 *   - the leader submits the result: trash reports of the shift's meeting point, each with at
 *     least one photo after (photos before are optional); anything else is refused (422)
 *   - ending early needs a result; it checks everyone out and the 60% rule counts until then
 *   - only volunteers who attended (and the leader / managers) add photos to the pool
 *   - the campaign is marked done only once every shift that is on has ended
 *   - a shift without a result 24 h after its end reminds its leader and managers, once a day
 *
 * identity, reward and notification clients are mocked; the DB is real. Time is passed in.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "it-shift-result-secret";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./setup/test-db";

jest.mock("../modules/organization/identity-user.client", () => ({
  fetchOrganizationOwnersByUserIds: async () => new Map(),
  getUserProfile: () => undefined,
  fetchUserIdsNearPoint: async () => [],
}));
jest.mock("../modules/reward/reward-service.client", () => ({
  rewardServiceClient: {
    getDifficultyByLevel: async (level: number) => ({ level, maxVolunteers: 20, suggestedMinVolunteers: 10, greenPoints: 10 }),
    getDifficultyByLevelStrict: async (level: number) => ({ level, maxVolunteers: 20, suggestedMinVolunteers: 10, greenPoints: 10 }),
    getDifficulties: async () => [],
  },
}));
jest.mock("../queue/register", () => ({
  backgroundJobDispatcher: {
    dispatch: jest.fn().mockResolvedValue(undefined),
    enqueue: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock("../modules/campaign/nearby-users", () => ({
  findNearbyUserIds: async () => [],
}));
jest.mock("../modules/campaign/notification-jobs.client", () => ({
  enqueueWebsiteNotificationsToUsers: jest.fn().mockResolvedValue(undefined),
  enqueueWebsiteNotification: jest.fn().mockResolvedValue(undefined),
  enqueueCampaignCompletionPendingAdminWebsiteNotification: jest.fn(),
}));

import { CampaignStatus } from "@da2/constants";
import { ReportStatus } from "../constants/status.enum";
import { campaignService } from "../modules/campaign/campaign.service";
import { shiftResultService as svc } from "../modules/campaign/campaign_shift_result/shift-result.service";
import { sendShiftResultReminders } from "../modules/campaign/campaign_shift_result/shift-result-reminders";
import { enqueueWebsiteNotificationsToUsers } from "../modules/campaign/notification-jobs.client";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const OWNER = randomUUID();
const LEADER = randomUUID();
const MGR = randomUUID();
const V1 = randomUUID();
const V2 = randomUUID();
const POINT = { latitude: 10.77, longitude: 106.7 };
const IMG = "https://res.cloudinary.com/demo/image/upload/a.jpg";

const code = (c: string) => ({ statusResponse: expect.objectContaining({ code: c }) });
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);

/** Shift A (led by LEADER, one trash report) and B (led by MGR), 4 hours each, from `start`. */
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
  const end = at(start, 4 * HOUR);
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
  const report = await prisma.report.create({
    data: { title: "Rác bờ kênh", ...POINT, status: ReportStatus._STATUS_INPROCESS, isVerify: true, campaignId: campaign.id },
  });
  const other = await prisma.report.create({
    data: { title: "Rác chỗ khác", ...POINT, status: ReportStatus._STATUS_INPROCESS, isVerify: true, campaignId: campaign.id },
  });
  await prisma.campaignMeetingPointReport.createMany({
    data: [
      { campaignId: campaign.id, meetingPointId: pa.id, reportId: report.id },
      { campaignId: campaign.id, meetingPointId: pb.id, reportId: other.id },
    ],
  });
  const shift = (meetingPointId: string, leaderUserId: string) =>
    prisma.campaignShift.create({
      data: { campaignId: campaign.id, dayId: day.id, meetingPointId, startAt: start, endAt: end, minVolunteers: 5, leaderUserId },
    });
  const a = await shift(pa.id, LEADER);
  const b = await shift(pb.id, MGR);
  await prisma.campaignShiftRegistration.createMany({
    data: [a, b].map((s) => ({ campaignId: campaign.id, shiftId: s.id, userId: V1 })),
  });
  return { id: campaign.id, a, b, reportId: report.id, otherReportId: other.id };
}

const goodResult = (reportId: string) => ({
  description: "Đã dọn xong bờ kênh",
  wasteBags: 12,
  wasteKg: 40.5,
  reports: [{ reportId, status: "cleaned" as const, beforeUrls: [IMG], afterUrls: [IMG] }],
  mediaIds: [],
});

const checkIn = (campaignId: string, shiftId: string, userId: string, checkInAt: Date) =>
  prisma.campaignShiftAttendance.create({
    data: { campaignId, shiftId, userId, checkInAt, preRegistered: true },
  });

let start: Date;

beforeEach(async () => {
  await prisma.$executeRaw(
    Prisma.sql`TRUNCATE TABLE "organizations", "campaigns", "reports" RESTART IDENTITY CASCADE`,
  );
  (enqueueWebsiteNotificationsToUsers as jest.Mock).mockClear();
  start = new Date(Date.now() - HOUR);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("status", () => {
  it("follows the clock and the result", async () => {
    const c = await seed(start);
    const status = async (now: Date) => (await svc.get(c.id, c.a.id, { userId: LEADER }, now)).status;
    expect(await status(at(start, -MIN))).toBe("upcoming");
    expect(await status(at(start, HOUR))).toBe("running");
    expect(await status(at(start, 5 * HOUR))).toBe("awaiting_result");
    await svc.save(c.id, c.a.id, LEADER, goodResult(c.reportId), at(start, 2 * HOUR));
    expect(await status(at(start, 3 * HOUR))).toBe("running");
    expect(await status(at(start, 5 * HOUR))).toBe("ended");

    await prisma.campaignShift.update({ where: { id: c.b.id }, data: { minVolunteers: 0 } });
    expect((await svc.get(c.id, c.b.id, { userId: MGR }, at(start, HOUR))).status).toBe("off");
  });

  it("shows the submitted result to anyone on a public campaign; the full pool only to those allowed", async () => {
    const c = await seed(start);
    const now = at(start, HOUR);
    await checkIn(c.id, c.a.id, V1, at(start, 5 * MIN));
    const chosen = await svc.addMedia(c.id, c.a.id, V1, { url: IMG, kind: "image" }, now);
    const left = await svc.addMedia(c.id, c.a.id, LEADER, { url: IMG, kind: "image" }, now);
    await svc.save(c.id, c.a.id, LEADER, { ...goodResult(c.reportId), mediaIds: [chosen.id] }, now);

    const outsider = await svc.get(c.id, c.a.id, { userId: V2 }, now);
    expect(outsider).toMatchObject({ status: "running", canView: false, canEdit: false, canContribute: false });
    expect(outsider.result?.reports).toHaveLength(1);
    expect(outsider.reportIds).toEqual([c.reportId]);
    expect(outsider.media.map((m) => m.id)).toEqual([chosen.id]);

    const admin = await svc.get(c.id, c.a.id, { userId: V2, role: "ADMIN" }, now);
    expect(admin.canView).toBe(true);
    expect(admin.media.map((m) => m.id).sort()).toEqual([chosen.id, left.id].sort());
    const volunteer = await svc.get(c.id, c.a.id, { userId: V1 }, now);
    expect(volunteer).toMatchObject({ canView: true, canEdit: false, canContribute: true });
    expect(volunteer.result?.reports).toHaveLength(1);
    expect(volunteer.media).toHaveLength(2);

    // Not public (back under review): outsiders see the status only.
    await prisma.campaign.update({ where: { id: c.id }, data: { status: CampaignStatus.PENDING_REVIEW } });
    const hidden = await svc.get(c.id, c.a.id, { userId: V2 }, now);
    expect(hidden).toMatchObject({ canView: false, result: null, reportIds: [], media: [] });
  });
});

describe("submitting a result", () => {
  it("refuses a report of another meeting point, missing photos, an empty result", async () => {
    const c = await seed(start);
    const now = at(start, HOUR);
    await expect(svc.save(c.id, c.a.id, LEADER, goodResult(c.otherReportId), now)).rejects.toMatchObject(
      code("SHIFT_RESULT_INVALID"),
    );
    const noAfter = goodResult(c.reportId);
    noAfter.reports[0].afterUrls = [];
    await expect(svc.save(c.id, c.a.id, LEADER, noAfter, now)).rejects.toMatchObject(code("SHIFT_RESULT_INVALID"));
    // Photos before are optional.
    const noBefore = goodResult(c.reportId);
    noBefore.reports[0].beforeUrls = [];
    await svc.save(c.id, c.a.id, LEADER, noBefore, now);
    expect(
      (await prisma.campaignShiftResultReport.findFirstOrThrow({ where: { reportId: c.reportId } })).beforeUrls,
    ).toEqual([]);
    await expect(
      svc.save(c.id, c.a.id, LEADER, { description: "x", reports: [], mediaIds: [] }, now),
    ).rejects.toMatchObject(code("SHIFT_RESULT_INVALID"));
    await expect(svc.save(c.id, c.a.id, LEADER, goodResult(c.reportId), at(start, -MIN))).rejects.toMatchObject(
      code("SHIFT_NOT_STARTED"),
    );
    await expect(svc.save(c.id, c.a.id, V1, goodResult(c.reportId), now)).rejects.toMatchObject(
      code("CAMPAIGN_PERMISSION_DENIED"),
    );
  });

  it("saves, replaces and logs; picks photos from the pool; locks after mark-done", async () => {
    const c = await seed(start);
    const now = at(start, HOUR);
    await checkIn(c.id, c.a.id, V1, at(start, 5 * MIN));
    const photo = await svc.addMedia(c.id, c.a.id, V1, { url: IMG, kind: "image" }, now);
    const saved = await svc.save(c.id, c.a.id, LEADER, { ...goodResult(c.reportId), mediaIds: [photo.id] }, now);
    expect(saved.result).toMatchObject({ wasteBags: 12, wasteKg: 40.5 });
    expect(saved.media[0]).toMatchObject({ id: photo.id, includedInResult: true });

    // A manager (not the leader) replaces it: only a photo, the report not handled.
    const again = await svc.save(
      c.id,
      c.a.id,
      MGR,
      { description: "Chỉ có ảnh", reports: [], mediaIds: [photo.id] },
      at(now, MIN),
    );
    expect(again.result?.reports).toHaveLength(0);
    expect(await prisma.campaignShiftResult.count()).toBe(1);
    expect(await prisma.campaignStatusLog.count({ where: { campaignId: c.id, event: "shift_result" } })).toBe(2);

    await prisma.campaign.update({ where: { id: c.id }, data: { status: CampaignStatus.PENDING_COMPLETION } });
    await expect(svc.save(c.id, c.a.id, LEADER, goodResult(c.reportId), now)).rejects.toMatchObject(
      code("SHIFT_RESULT_LOCKED"),
    );
  });
});

describe("ending a shift early", () => {
  it("needs a result; then ends it, checks everyone out, 60% counted until then", async () => {
    const c = await seed(start);
    await checkIn(c.id, c.a.id, V1, at(start, 10 * MIN));
    const endAt = at(start, 2 * HOUR);
    await expect(svc.endEarly(c.id, c.a.id, LEADER, endAt)).rejects.toMatchObject(code("SHIFT_RESULT_REQUIRED"));
    await expect(svc.endEarly(c.id, c.a.id, V1, endAt)).rejects.toMatchObject(code("CAMPAIGN_PERMISSION_DENIED"));

    await svc.save(c.id, c.a.id, LEADER, goodResult(c.reportId), at(start, HOUR));
    const ended = await svc.endEarly(c.id, c.a.id, LEADER, endAt);
    expect(ended).toMatchObject({ status: "ended", checkedOut: 1 });
    const row = await prisma.campaignShiftAttendance.findUniqueOrThrow({
      where: { shiftId_userId: { shiftId: c.a.id, userId: V1 } },
    });
    expect(row.checkOutAt?.getTime()).toBe(endAt.getTime());
    // 110 of 120 minutes: eligible (it would be 110 of 240 without ending early).
    const overview = await svc.overview(c.id, { userId: OWNER }, at(endAt, MIN));
    expect(overview.shifts.find((s) => s.shiftId === c.a.id)).toMatchObject({
      status: "ended",
      present: 1,
      eligible: 1,
      hasResult: true,
    });
    expect((await svc.get(c.id, c.a.id, { userId: LEADER }, at(endAt, MIN))).status).toBe("ended");
    await expect(svc.endEarly(c.id, c.a.id, LEADER, at(endAt, MIN))).rejects.toMatchObject(code("CONFLICT"));
    expect(await prisma.campaignStatusLog.count({ where: { campaignId: c.id, event: "shift_ended_early" } })).toBe(1);
  });
});

describe("photo pool", () => {
  it("only volunteers who attended add photos; uploaders and the leader remove them", async () => {
    const c = await seed(start);
    const now = at(start, HOUR);
    await expect(svc.addMedia(c.id, c.a.id, V2, { url: IMG, kind: "image" }, now)).rejects.toMatchObject(
      code("CAMPAIGN_PERMISSION_DENIED"),
    );
    await checkIn(c.id, c.a.id, V1, at(start, 5 * MIN));
    await expect(svc.addMedia(c.id, c.a.id, V1, { url: IMG, kind: "image" }, at(start, -MIN))).rejects.toMatchObject(
      code("SHIFT_NOT_STARTED"),
    );
    const mine = await svc.addMedia(c.id, c.a.id, V1, { url: IMG, kind: "image" }, now);
    const leaders = await svc.addMedia(c.id, c.a.id, LEADER, { url: IMG, kind: "video" }, now);
    await expect(svc.removeMedia(c.id, c.a.id, leaders.id, V1, now)).rejects.toMatchObject(
      code("CAMPAIGN_PERMISSION_DENIED"),
    );
    await svc.removeMedia(c.id, c.a.id, mine.id, V1, now);
    await svc.removeMedia(c.id, c.a.id, leaders.id, LEADER, now);
    expect(await prisma.campaignShiftMedia.count({ where: { shiftId: c.a.id, deletedAt: null } })).toBe(0);

    await prisma.campaignShiftAttendance.update({
      where: { shiftId_userId: { shiftId: c.a.id, userId: V1 } },
      data: { excludedAt: now, excludedBy: LEADER, excludeReason: "x" },
    });
    await expect(svc.addMedia(c.id, c.a.id, V1, { url: IMG, kind: "image" }, now)).rejects.toMatchObject(
      code("CAMPAIGN_PERMISSION_DENIED"),
    );
  });
});

describe("overview and marking done", () => {
  it("totals the shifts; mark-done waits for every shift that is on", async () => {
    // Both shifts are over by now.
    const c = await seed(new Date(Date.now() - 5 * HOUR));
    // Anyone signed in sees the overview of a public campaign.
    expect((await svc.overview(c.id, { userId: V2 })).shifts).toHaveLength(2);
    await svc.save(c.id, c.a.id, LEADER, goodResult(c.reportId));

    let overview = await svc.overview(c.id, { userId: OWNER });
    expect(overview.totals).toMatchObject({
      activeShifts: 2,
      endedShifts: 1,
      notEndedShiftIds: [c.b.id],
      registered: 2,
      wasteBags: 12,
      wasteKg: 40.5,
      reports: { cleaned: 1, partial: 0, untouched: 1 },
    });

    await expect(campaignService.submitCampaignCompletionForAdminApproval(c.id, OWNER)).rejects.toMatchObject({
      ...code("CAMPAIGN_SHIFTS_NOT_ENDED"),
      data: { shiftIds: [c.b.id] },
    });

    await svc.save(c.id, c.b.id, MGR, {
      description: "Làm được một phần",
      reports: [{ reportId: c.otherReportId, status: "partial", beforeUrls: [IMG], afterUrls: [IMG] }],
      mediaIds: [],
    });
    overview = await svc.overview(c.id, { userId: OWNER, role: "ADMIN" });
    expect(overview.totals).toMatchObject({ endedShifts: 2, reports: { cleaned: 1, partial: 1, untouched: 0 } });
    await campaignService.submitCampaignCompletionForAdminApproval(c.id, OWNER);
    const done = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(done.status).toBe(CampaignStatus.PENDING_COMPLETION);
  });

  it("keeps the overview of a campaign that is not public to its managers and admins", async () => {
    const c = await seed(new Date(Date.now() - 5 * HOUR));
    await prisma.campaign.update({ where: { id: c.id }, data: { status: CampaignStatus.DRAFT } });
    await expect(svc.overview(c.id, { userId: V2 })).rejects.toMatchObject(code("CAMPAIGN_PERMISSION_DENIED"));
    expect((await svc.overview(c.id, { userId: OWNER })).shifts).toHaveLength(2);
    expect((await svc.overview(c.id, { userId: V2, role: "ADMIN" })).shifts).toHaveLength(2);
    await expect(svc.overview(randomUUID(), { userId: V2 })).rejects.toMatchObject(code("NOT_FOUND"));
  });

  it("a shift that is off does not block mark-done", async () => {
    const c = await seed(new Date(Date.now() - 5 * HOUR));
    await svc.save(c.id, c.a.id, LEADER, goodResult(c.reportId));
    await prisma.campaignShift.update({ where: { id: c.b.id }, data: { minVolunteers: 0 } });
    // Its report was handled by no shift: it needs a reason (spec 5.1).
    await campaignService.submitCampaignCompletionForAdminApproval(c.id, OWNER, undefined, [
      { reportId: c.otherReportId, reason: "Ca đã tắt" },
    ]);
  });
});

describe("missing result reminder", () => {
  it("reminds the leader and managers 24 h after the end, then once a day", async () => {
    const c = await seed(start);
    const end = at(start, 4 * HOUR);
    await prisma.campaignShift.update({ where: { id: c.b.id }, data: { minVolunteers: 0 } });
    const send = enqueueWebsiteNotificationsToUsers as jest.Mock;

    expect(await sendShiftResultReminders(at(end, 23 * HOUR))).toBe(0);
    expect(await sendShiftResultReminders(at(end, 25 * HOUR))).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0][0];
    expect(call.kind).toBe("CAMPAIGN_SHIFT_RESULT_MISSING");
    expect(call.userIds).toEqual(expect.arrayContaining([LEADER, OWNER, MGR]));
    expect(call.payload).toMatchObject({ campaignId: c.id, shiftId: c.a.id });

    expect(await sendShiftResultReminders(at(end, 30 * HOUR))).toBe(0);
    expect(await sendShiftResultReminders(at(end, 49 * HOUR))).toBe(1);

    await svc.save(c.id, c.a.id, LEADER, goodResult(c.reportId), at(end, 50 * HOUR));
    expect(await sendShiftResultReminders(at(end, 80 * HOUR))).toBe(0);
  });
});
