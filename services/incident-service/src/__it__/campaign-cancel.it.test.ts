/**
 * Cancelling a campaign (Đặc tả luồng chiến dịch-7, 3.6), against a real Postgres.
 *
 *   - the creator or an owner cancels an upcoming, running, or approved-and-under-review
 *     campaign, with a reason; a plain manager cannot
 *   - its waste points go back to the waiting list; volunteers and the team hear
 *   - a campaign with volunteers is cancelled, not deleted
 *
 * identity, reward and notification clients are mocked; the DB is real.
 */
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
import { campaignRegistrationService } from "../modules/campaign/campaign_registration/campaign_registration.service";

const OWNER = randomUUID();
const CM = randomUUID();
const ADMIN = randomUUID();
const VOL = randomUUID();
const VOL2 = randomUUID();
const MGR = randomUUID();
const S = CampaignStatus;
const HOUR = 60 * 60 * 1000;
const POINT = { latitude: 10.77, longitude: 106.7 };

let orgId: string;

const code = (c: string) => ({ statusResponse: expect.objectContaining({ code: c }) });

async function seedReport(offset = 0.001) {
  return prisma.report.create({
    data: {
      title: "Rác bờ kênh",
      latitude: POINT.latitude + offset,
      longitude: POINT.longitude,
      status: ReportStatus._STATUS_TODO,
      isVerify: true,
    },
  });
}

/** Local 07:00–11:00, `daysAhead` days from now. */
function dayAt(daysAhead: number) {
  const day = new Date(Date.now() + daysAhead * 24 * HOUR);
  day.setUTCHours(0, 0, 0, 0);
  return { startAt: day.toISOString(), endAt: new Date(day.getTime() + 4 * HOUR).toISOString() };
}

/** Two days, one meeting point, approved; VOL is registered on both shifts. */
async function approvedCampaign() {
  const report = await seedReport();
  const draft = await campaignService.createCampaign(CM, {
    organizationId: orgId,
    title: "Dọn rác kênh Nhiêu Lộc",
    description: "<p>" + "Cùng nhau dọn sạch bờ kênh. ".repeat(6) + "</p>",
    banner: "https://example.com/banner.jpg",
    difficulty: 1,
    days: [dayAt(7), dayAt(8)],
    contactName: "Nguyễn Văn A",
    contactPhone: "0901234567",
    meetingPoints: [{ ...POINT, radiusKm: 1, reportIds: [report.id] }],
    shifts: [0, 1].map((dayIndex) => ({
      dayIndex,
      meetingPointIndex: 0,
      minVolunteers: 10,
      leaderUserId: CM,
    })),
  } as never);
  await campaignService.submitCampaign(draft.id, CM);
  await campaignService.reviewCampaign(draft.id, ADMIN, "approve", null);
  const shifts = await prisma.campaignShift.findMany({
    where: { campaignId: draft.id },
    orderBy: { startAt: "asc" },
  });
  await campaignRegistrationService.setMyShifts(draft.id, VOL, {
    shiftIds: shifts.map((s) => s.id),
    acceptConditions: true,
  });
  return { id: draft.id, reportId: report.id, shifts };
}

const statusOf = async (id: string) =>
  (await prisma.campaign.findUniqueOrThrow({ where: { id } })).status;

const outboxKinds = async () =>
  (await prisma.outboxEvent.findMany({ orderBy: { createdAt: "asc" } })).map(
    (e) => (e.payload as { kind: string; userIds: string[] }),
  );

beforeEach(async () => {
  await prisma.$executeRaw(
    Prisma.sql`TRUNCATE TABLE "outbox_events", "organization_applications", "organizations", "reports" RESTART IDENTITY CASCADE`,
  );
  const org = await prisma.organization.create({
    data: {
      name: `Org ${randomUUID()}`,
      slug: `org-${randomUUID()}`,
      logoUrl: "https://example.com/logo.png",
      status: 1,
      trustTier: "VERIFIED",
      kycStatus: "APPROVED",
      members: {
        create: [
          { userId: OWNER, role: "OWNER", source: "INTERNAL" },
          { userId: CM, role: "CAMPAIGN_MANAGER", source: "INTERNAL" },
          { userId: MGR, role: "CAMPAIGN_MANAGER", source: "INTERNAL" },
        ],
      },
    },
  });
  orgId = org.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});


const cancelOf = async (id: string) =>
  (await prisma.outboxEvent.findMany({ orderBy: { createdAt: "asc" } }))
    .map((e) => e.payload as { kind: string; userIds: string[]; payload: Record<string, string> })
    .filter((p) => p.kind === "CAMPAIGN_CANCELLED" && p.payload.campaignId === id);

describe("cancelling", () => {
  it("an owner cancels an upcoming campaign: reports released, volunteers and the team hear", async () => {
    const c = await approvedCampaign();
    await prisma.campaignManager.create({ data: { campaignId: c.id, userId: MGR, assignedBy: CM } });
    const res = await campaignService.cancelCampaign(c.id, OWNER, "Bão đổ bộ");

    expect(res.status).toBe(S.CANCELLED);
    const row = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.rejectReason).toBe("Bão đổ bộ");
    const report = await prisma.report.findUniqueOrThrow({ where: { id: c.reportId } });
    expect(report.campaignId).toBeNull();
    expect(report.status).toBe(ReportStatus._STATUS_TODO);
    const log = await prisma.campaignStatusLog.findFirstOrThrow({ where: { campaignId: c.id, event: "cancel" } });
    expect(log).toMatchObject({ fromStatus: S.UPCOMING, toStatus: S.CANCELLED, actorId: OWNER, reason: "Bão đổ bộ" });

    const notices = await cancelOf(c.id);
    expect(notices.map((n) => [...n.userIds].sort())).toEqual([[VOL], [CM, MGR].sort()]);
    expect(notices[0].payload).toMatchObject({ byOrganizer: "1", reason: "Bão đổ bộ" });
  });

  it("the creator cancels a running campaign; a plain manager may not", async () => {
    const c = await approvedCampaign();
    await prisma.campaignManager.create({ data: { campaignId: c.id, userId: MGR, assignedBy: CM } });
    await prisma.campaign.update({ where: { id: c.id }, data: { status: S.ACTIVE } });
    await expect(campaignService.cancelCampaign(c.id, MGR, "Không đủ người")).rejects.toMatchObject(
      code("CAMPAIGN_PERMISSION_DENIED"),
    );
    await campaignService.cancelCampaign(c.id, CM, "Không đủ người");
    expect(await statusOf(c.id)).toBe(S.CANCELLED);
  });

  it("needs a reason, and an approved campaign: not a draft, not a completed one", async () => {
    const c = await approvedCampaign();
    await expect(campaignService.cancelCampaign(c.id, CM, "  ")).rejects.toMatchObject(
      code("VALIDATION_ERROR"),
    );
    await prisma.campaign.update({ where: { id: c.id }, data: { status: S.COMPLETED } });
    await expect(campaignService.cancelCampaign(c.id, CM, "Muộn")).rejects.toMatchObject(
      code("CAMPAIGN_NOT_CANCELLABLE"),
    );
    await prisma.campaign.update({ where: { id: c.id }, data: { status: S.PENDING_REVIEW, approvedAt: null } });
    await expect(campaignService.cancelCampaign(c.id, CM, "Nháp")).rejects.toMatchObject(
      code("CAMPAIGN_NOT_CANCELLABLE"),
    );
  });

  it("an approved campaign under review again with volunteers is cancelled, not deleted", async () => {
    const c = await approvedCampaign();
    await prisma.campaign.update({ where: { id: c.id }, data: { status: S.PENDING_REVIEW } });
    await expect(campaignService.deleteCampaign(c.id, CM)).rejects.toMatchObject(
      code("CAMPAIGN_HAS_VOLUNTEERS"),
    );
    await campaignService.cancelCampaign(c.id, CM, "Đổi kế hoạch");
    expect(await statusOf(c.id)).toBe(S.CANCELLED);
  });
});
