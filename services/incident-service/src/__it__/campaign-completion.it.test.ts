/**
 * Marking a campaign done and the admin's decision (Đặc tả luồng chiến dịch-8, 5.1–5.3), against a
 * real Postgres.
 *
 *   - the submission is built from the shifts' results; a report no shift handled needs a reason
 *     (422 CAMPAIGN_REPORTS_UNHANDLED), then the snapshot is saved
 *   - residents are invited around every meeting point
 *   - the red flag: ≥ 30% "not clean" out of ≥ 5 answers
 *   - approve settles the difficulty: handled reports completed, unhandled back to the list, points
 *     at the settled difficulty
 *   - reject reopens shifts (awaiting result until saved again); a 4th rejection is refused (409)
 *   - cancel: cancelled, reports released, no points
 *
 * identity, reward and notification clients are mocked; the DB is real. Time is passed in.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "it-completion-secret";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./setup/test-db";

jest.mock("../modules/organization/identity-user.client", () => ({
  fetchOrganizationOwnersByUserIds: async () => new Map(),
  getUserProfile: () => undefined,
  fetchUserIdsNearPoint: async () => [],
}));
/** Green points = 10 × difficulty, so the settled difficulty shows in the credits. */
jest.mock("../modules/reward/reward-service.client", () => {
  const tier = async (level: number) => ({
    level,
    maxVolunteers: 20,
    suggestedMinVolunteers: 10,
    greenPoints: level * 10,
  });
  return {
    rewardServiceClient: {
      getDifficultyByLevel: tier,
      getDifficultyByLevelStrict: tier,
      getDifficulties: async () => [],
    },
  };
});
jest.mock("../queue/register", () => ({
  backgroundJobDispatcher: {
    dispatch: jest.fn().mockResolvedValue(undefined),
    enqueue: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock("../modules/campaign/nearby-users", () => ({
  findNearbyUserIds: jest.fn().mockResolvedValue([]),
}));
jest.mock("../modules/campaign/notification-jobs.client", () => ({
  enqueueWebsiteNotificationsToUsers: jest.fn().mockResolvedValue(undefined),
  enqueueWebsiteNotification: jest.fn().mockResolvedValue(undefined),
  enqueueCampaignCompletionPendingAdminWebsiteNotification: jest.fn(),
}));

import { CampaignStatus } from "@da2/constants";
import { ReportStatus } from "../constants/status.enum";
import { OutboxEventType } from "../outbox/outbox.types";
import { campaignService } from "../modules/campaign/campaign.service";
import { campaignCompletionService } from "../modules/campaign/campaign_completion/completion.service";
import { shiftResultService } from "../modules/campaign/campaign_shift_result/shift-result.service";
import { findNearbyUserIds } from "../modules/campaign/nearby-users";
import { enqueueWebsiteNotificationsToUsers } from "../modules/campaign/notification-jobs.client";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const OWNER = randomUUID();
const MGR = randomUUID();
const ADMIN = randomUUID();
const V1 = randomUUID();
const POINT = { latitude: 10.77, longitude: 106.7 };
const IMG = "https://res.cloudinary.com/demo/image/upload/a.jpg";
const IMG2 = "https://res.cloudinary.com/demo/image/upload/b.jpg";

const code = (c: string) => ({ statusResponse: expect.objectContaining({ code: c }) });
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);

/** Polls until `check` passes (fire-and-forget notifications), at most ~2 s. */
async function eventually(check: () => void): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      check();
      return;
    } catch (e) {
      if (i > 40) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/**
 * A running campaign (difficulty 1) whose two shifts ended an hour ago: point A has report R1,
 * point B reports R2 and R3. V1 registered and attended both shifts.
 */
async function seed() {
  const start = new Date(Date.now() - 5 * HOUR);
  const end = at(start, 4 * HOUR);
  const org = await prisma.organization.create({
    data: {
      name: `Org ${randomUUID()}`,
      slug: `org-${randomUUID()}`,
      logoUrl: "https://example.com/logo.png",
      status: 1,
      members: {
        create: [
          { userId: OWNER, role: "OWNER", source: "INTERNAL" },
          { userId: MGR, role: "CAMPAIGN_MANAGER", source: "INTERNAL" },
        ],
      },
    },
  });
  const campaign = await prisma.campaign.create({
    data: {
      title: "Dọn rác kênh",
      status: CampaignStatus.ACTIVE,
      organizationId: org.id,
      createdBy: OWNER,
      difficulty: 1,
      approvedAt: start,
      ...POINT,
      campaignManagers: {
        create: [
          { userId: OWNER, assignedBy: OWNER },
          { userId: MGR, assignedBy: OWNER },
        ],
      },
    },
  });
  const day = await prisma.campaignDay.create({ data: { campaignId: campaign.id, startAt: start, endAt: end } });
  const [pa, pb] = await Promise.all(
    [0, 1].map((i) =>
      prisma.campaignMeetingPoint.create({
        data: { campaignId: campaign.id, latitude: POINT.latitude + i * 0.1, longitude: POINT.longitude, radiusKm: 1, sortOrder: i },
      }),
    ),
  );
  const report = (title: string) =>
    prisma.report.create({
      data: { title, ...POINT, status: ReportStatus._STATUS_INPROCESS, isVerify: true, campaignId: campaign.id },
    });
  const [r1, r2, r3] = await Promise.all([report("R1"), report("R2"), report("R3")]);
  await prisma.campaignMeetingPointReport.createMany({
    data: [
      { campaignId: campaign.id, meetingPointId: pa.id, reportId: r1.id },
      { campaignId: campaign.id, meetingPointId: pb.id, reportId: r2.id },
      { campaignId: campaign.id, meetingPointId: pb.id, reportId: r3.id },
    ],
  });
  const shift = (meetingPointId: string) =>
    prisma.campaignShift.create({
      data: { campaignId: campaign.id, dayId: day.id, meetingPointId, startAt: start, endAt: end, minVolunteers: 5, leaderUserId: MGR },
    });
  const a = await shift(pa.id);
  const b = await shift(pb.id);
  await prisma.campaignShiftRegistration.createMany({
    data: [a, b].map((s) => ({ campaignId: campaign.id, shiftId: s.id, userId: V1 })),
  });
  await prisma.campaignShiftAttendance.createMany({
    data: [a, b].map((s) => ({
      campaignId: campaign.id,
      shiftId: s.id,
      userId: V1,
      checkInAt: start,
      checkOutAt: end,
      preRegistered: true,
    })),
  });
  return { id: campaign.id, start, end, a, b, pa, pb, r1: r1.id, r2: r2.id, r3: r3.id };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

/** A: R1 cleaned. B: R2 partial (R3 untouched). */
async function saveResults(c: Seeded) {
  await shiftResultService.save(c.id, c.a.id, MGR, {
    description: "Xong điểm A",
    reports: [{ reportId: c.r1, status: "cleaned", beforeUrls: [IMG], afterUrls: [IMG] }],
    mediaIds: [],
  });
  await shiftResultService.save(c.id, c.b.id, MGR, {
    description: "Một phần điểm B",
    reports: [{ reportId: c.r2, status: "partial", beforeUrls: [IMG], afterUrls: [IMG2] }],
    mediaIds: [],
  });
}

const markDone = (c: Seeded, unhandled?: Array<{ reportId: string; reason: string }>) =>
  campaignService.submitCampaignCompletionForAdminApproval(c.id, OWNER, undefined, unhandled);

async function submitted() {
  const c = await seed();
  await saveResults(c);
  await markDone(c, [{ reportId: c.r3, reason: "Nước dâng, không tiếp cận được" }]);
  return c;
}

const review = (c: Seeded, input: Parameters<typeof campaignService.adminReviewCampaignCompletion>[2]) =>
  campaignService.adminReviewCampaignCompletion(c.id, ADMIN, input);

beforeEach(async () => {
  await prisma.$executeRaw(
    Prisma.sql`TRUNCATE TABLE "organizations", "campaigns", "reports" RESTART IDENTITY CASCADE`,
  );
  (enqueueWebsiteNotificationsToUsers as jest.Mock).mockClear();
  (findNearbyUserIds as jest.Mock).mockClear();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("marking done (5.1)", () => {
  it("needs a reason for each report no shift handled; then saves the snapshot", async () => {
    const c = await seed();
    await saveResults(c);
    await expect(markDone(c)).rejects.toMatchObject({
      ...code("CAMPAIGN_REPORTS_UNHANDLED"),
      data: { reportIds: [c.r3] },
    });
    await expect(markDone(c, [{ reportId: c.r3, reason: "   " }])).rejects.toMatchObject(
      code("CAMPAIGN_REPORTS_UNHANDLED"),
    );
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe(CampaignStatus.ACTIVE);

    const res = await markDone(c, [{ reportId: c.r3, reason: "Nước dâng" }]);
    expect(res.status).toBe(CampaignStatus.PENDING_COMPLETION);
    expect(res.completionSubmittedAt).not.toBeNull();
    const rows = await prisma.campaignCompletionReport.findMany({ where: { campaignId: c.id } });
    const byReport = Object.fromEntries(rows.map((r) => [r.reportId, r]));
    expect(byReport[c.r1]).toMatchObject({ status: "cleaned", afterUrls: [IMG], reason: null });
    expect(byReport[c.r2]).toMatchObject({ status: "partial", beforeUrls: [IMG], afterUrls: [IMG2] });
    expect(byReport[c.r3]).toMatchObject({ status: "unhandled", reason: "Nước dâng" });

    const view = await campaignCompletionService.getForReview(c.id, { userId: ADMIN, role: "ADMIN" });
    expect(view.submission).toMatchObject({ preview: false, counts: { cleaned: 1, partial: 1, unhandled: 1 } });
    expect(view).toMatchObject({ rejectionCount: 0, canReject: true });
    expect(view.shifts).toHaveLength(2);
  });

  it("invites residents around every meeting point", async () => {
    const c = await seed();
    await saveResults(c);
    await markDone(c, [{ reportId: c.r3, reason: "x" }]);
    await eventually(() => expect(findNearbyUserIds).toHaveBeenCalled());
    const [points, exclude] = (findNearbyUserIds as jest.Mock).mock.calls[0];
    expect(points).toEqual([
      { latitude: c.pa.latitude, longitude: c.pa.longitude },
      { latitude: c.pb.latitude, longitude: c.pb.longitude },
    ]);
    expect(exclude).toEqual(expect.arrayContaining([OWNER, MGR, V1]));
  });

  it("the manager previews the submission before marking done", async () => {
    const c = await seed();
    await saveResults(c);
    const view = await campaignCompletionService.getForReview(c.id, { userId: MGR });
    expect(view.submission.preview).toBe(true);
    expect(view.submission.reports.find((r) => r.reportId === c.r3)).toMatchObject({ status: "unhandled" });
    await expect(campaignCompletionService.getForReview(c.id, { userId: V1 })).rejects.toMatchObject(
      code("CAMPAIGN_PERMISSION_DENIED"),
    );
  });
});

describe("residents' red flag", () => {
  it("is raised at 30% not clean out of at least 5 answers", async () => {
    const c = await submitted();
    const vote = (value: number) =>
      prisma.campaignCompletionVerification.create({ data: { campaignId: c.id, userId: randomUUID(), value } });
    const flagged = async () =>
      (await campaignCompletionService.getForReview(c.id, { userId: ADMIN, role: "ADMIN" })).verification.flagged;

    await Promise.all([vote(1), vote(1), vote(-1), vote(-1)]);
    expect(await flagged()).toBe(false); // 50% but only 4 answers
    await vote(1);
    expect(await flagged()).toBe(true); // 2 / 5 = 40%
    await Promise.all([vote(1), vote(1)]);
    expect(await flagged()).toBe(false); // 2 / 7 ≈ 29%
    const res = await campaignService.getCampaignById(c.id, OWNER);
    expect(res?.completionVerification).toMatchObject({ cleanCount: 5, notCleanCount: 2, flagged: false });
  });
});

describe("admin decision (5.2)", () => {
  it("approve settles the difficulty: handled done, unhandled released, points at the new level", async () => {
    const c = await submitted();
    await expect(review(c, { decision: "approve", difficulty: 9 })).rejects.toMatchObject(code("VALIDATION_ERROR"));

    const res = await review(c, { decision: "approve", difficulty: 3 });
    expect(res).toMatchObject({ status: CampaignStatus.COMPLETED, difficulty: 3 });

    const reports = await prisma.report.findMany({ where: { id: { in: [c.r1, c.r2, c.r3] } } });
    const byId = Object.fromEntries(reports.map((r) => [r.id, r]));
    expect(byId[c.r1]).toMatchObject({ status: ReportStatus._STATUS_COMPLETED, campaignId: c.id });
    expect(byId[c.r2]).toMatchObject({ status: ReportStatus._STATUS_COMPLETED, campaignId: c.id });
    expect(byId[c.r3]).toMatchObject({ status: ReportStatus._STATUS_TODO, campaignId: null });

    const outbox = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: c.id, eventType: OutboxEventType.CAMPAIGN_COMPLETION_GREEN_POINTS },
    });
    expect(outbox.payload).toMatchObject({ credits: [{ userId: V1, points: 30 }] });
    const log = await prisma.campaignStatusLog.findFirstOrThrow({
      where: { campaignId: c.id, event: "approve_completion" },
    });
    expect(log.changes).toMatchObject({ difficulty: { from: 1, to: 3 } });
  });

  it("reject reopens shifts until saved again; a 4th rejection is refused", async () => {
    const c = await submitted();
    await expect(review(c, { decision: "reject", rejectReason: "Thiếu ảnh" })).rejects.toMatchObject(
      code("VALIDATION_ERROR"),
    );
    await expect(
      review(c, { decision: "reject", rejectReason: "Thiếu ảnh", shiftIds: [randomUUID()] }),
    ).rejects.toMatchObject(code("VALIDATION_ERROR"));

    for (let round = 1; round <= 3; round++) {
      const res = await review(c, { decision: "reject", rejectReason: "Thiếu ảnh sau", shiftIds: [c.b.id] });
      expect(res).toMatchObject({ status: CampaignStatus.ACTIVE, completionRejectionCount: round, rejectReason: "Thiếu ảnh sau" });
      expect(res.shifts.find((s) => s.id === c.b.id)).toMatchObject({
        status: "awaiting_result",
        reopenReason: "Thiếu ảnh sau",
      });
      expect(res.shifts.find((s) => s.id === c.a.id)?.status).toBe("ended");

      // Marking done waits for the reopened shift.
      await expect(markDone(c, [{ reportId: c.r3, reason: "x" }])).rejects.toMatchObject({
        ...code("CAMPAIGN_SHIFTS_NOT_ENDED"),
        data: { shiftIds: [c.b.id] },
      });
      if (round === 1) {
        await eventually(() =>
          expect(enqueueWebsiteNotificationsToUsers).toHaveBeenCalledWith(
            expect.objectContaining({
              kind: "CAMPAIGN_COMPLETION_REJECTED_BY_ADMIN",
              userIds: expect.arrayContaining([OWNER, MGR]),
              payload: expect.objectContaining({ rejectReason: "Thiếu ảnh sau", shifts: expect.stringContaining("#2") }),
            }),
          ),
        );
      }
      await shiftResultService.save(c.id, c.b.id, MGR, {
        description: "Bổ sung",
        reports: [{ reportId: c.r2, status: "cleaned", beforeUrls: [IMG], afterUrls: [IMG2] }],
        mediaIds: [],
      });
      const overview = await shiftResultService.overview(c.id, { userId: OWNER });
      expect(overview.shifts.find((s) => s.shiftId === c.b.id)).toMatchObject({ status: "ended", reopenedAt: null });
      await markDone(c, [{ reportId: c.r3, reason: "x" }]);
    }

    await expect(
      review(c, { decision: "reject", rejectReason: "Lần 4", shiftIds: [c.b.id] }),
    ).rejects.toMatchObject(code("CAMPAIGN_COMPLETION_REJECT_LIMIT"));
    const view = await campaignCompletionService.getForReview(c.id, { userId: ADMIN, role: "ADMIN" });
    expect(view).toMatchObject({ rejectionCount: 3, canReject: false });
    expect(view.submission.reports.find((r) => r.reportId === c.r2)?.status).toBe("cleaned");
    await review(c, { decision: "approve" });
  });

  it("cancel: cancelled, reports released, no points, everyone hears", async () => {
    const c = await submitted();
    await expect(review(c, { decision: "cancel" })).rejects.toMatchObject(code("VALIDATION_ERROR"));
    const res = await review(c, { decision: "cancel", rejectReason: "Ảnh giả" });
    expect(res).toMatchObject({ status: CampaignStatus.CANCELLED, rejectReason: "Ảnh giả" });

    const reports = await prisma.report.findMany({ where: { id: { in: [c.r1, c.r2, c.r3] } } });
    expect(reports.every((r) => r.campaignId === null && r.status === ReportStatus._STATUS_TODO)).toBe(true);
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: c.id, eventType: OutboxEventType.CAMPAIGN_COMPLETION_GREEN_POINTS },
      }),
    ).toBe(0);
    const notices = await prisma.outboxEvent.findMany({
      where: { aggregateId: c.id, eventType: OutboxEventType.WEBSITE_NOTIFICATION },
    });
    const payloads = notices.map((n) => n.payload as { kind: string; userIds: string[]; payload: Record<string, string> });
    expect(payloads.map((p) => p.kind)).toEqual(["CAMPAIGN_CANCELLED", "CAMPAIGN_CANCELLED"]);
    expect(payloads.flatMap((p) => p.userIds)).toEqual(expect.arrayContaining([V1, OWNER, MGR]));
    expect(payloads[0].payload).toMatchObject({ byAdmin: "1", reason: "Ảnh giả" });
    await expect(review(c, { decision: "approve" })).rejects.toMatchObject(code("CAMPAIGN_INVALID_TRANSITION"));
  });
});
