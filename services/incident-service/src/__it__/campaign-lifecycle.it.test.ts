/**
 * Campaign lifecycle, phases 1–2 (Đặc tả luồng chiến dịch), against a real Postgres.
 *
 *   - a draft locks nothing; submitting locks its reports and goes to PENDING_REVIEW
 *   - two campaigns racing for one report: one wins, the other gets 409 with the report id
 *   - submit re-checks every rule and returns all problems at once
 *   - admin approve / request changes / block, with audit log and notifications
 *   - an admin who belongs to the organization cannot review it
 *   - status cannot be written through PUT /campaigns/:id
 *   - the sweep expires overdue reviews and deletes stale drafts
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
    getDifficultyByLevel: async (level: number) => ({
      level,
      maxVolunteers: 20,
      greenPoints: 10,
    }),
    getDifficulties: async () => [],
  },
}));
jest.mock("../queue/register", () => ({
  backgroundJobDispatcher: {
    dispatch: jest.fn().mockResolvedValue(undefined),
    enqueue: jest.fn().mockResolvedValue(undefined),
  },
}));
const notify = jest.fn().mockResolvedValue(undefined);
jest.mock("../modules/campaign/notification-jobs.client", () => ({
  enqueueWebsiteNotificationsToUsers: (...a: unknown[]) => notify(...a),
  enqueueWebsiteNotification: jest.fn().mockResolvedValue(undefined),
  enqueueCampaignCompletionPendingAdminWebsiteNotification: jest.fn(),
}));

import { campaignService } from "../modules/campaign/campaign.service";
import { campaignLifecycleService } from "../modules/campaign/campaign-lifecycle.service";
import { CampaignStatus } from "@da2/constants";
import { ReportStatus } from "../constants/status.enum";

const OWNER = randomUUID();
const CM = randomUUID();
const ADMIN = randomUUID();
const S = CampaignStatus;
const HOUR = 60 * 60 * 1000;
const POINT = { latitude: 10.77, longitude: 106.7 };

let orgId: string;

/** Notifications are sent after commit without awaiting; poll until the assertion holds. */
async function eventually(assertion: () => void, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

const code = (c: string) => ({ statusResponse: expect.objectContaining({ code: c }) });

async function resetTables(): Promise<void> {
  await prisma.$executeRaw(
    Prisma.sql`TRUNCATE TABLE "outbox_events", "organization_applications", "organizations", "reports" RESTART IDENTITY CASCADE`,
  );
}

async function seedOrganization(trustTier = "VERIFIED") {
  const org = await prisma.organization.create({
    data: {
      name: `Org ${randomUUID()}`,
      slug: `org-${randomUUID()}`,
      logoUrl: "https://example.com/logo.png",
      status: 1,
      trustTier,
      members: {
        create: [
          { userId: OWNER, role: "OWNER", source: "INTERNAL" },
          { userId: CM, role: "CAMPAIGN_MANAGER", source: "INTERNAL" },
        ],
      },
    },
  });
  return org.id;
}

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

/** Local 07:00–11:00, a week from now. */
function schedule() {
  const day = new Date(Date.now() + 7 * 24 * HOUR);
  day.setUTCHours(0, 0, 0, 0);
  return { start: day, end: new Date(day.getTime() + 4 * HOUR) };
}

function draftRequest(reportIds: string[], overrides: Record<string, unknown> = {}) {
  const { start, end } = schedule();
  return {
    organizationId: orgId,
    title: "Dọn rác kênh Nhiêu Lộc",
    description: "<p>" + "Cùng nhau dọn sạch bờ kênh. ".repeat(6) + "</p>",
    banner: "https://example.com/banner.jpg",
    difficulty: 1,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    contactName: "Nguyễn Văn A",
    contactPhone: "0901234567",
    meetingPoints: [
      {
        ...POINT,
        radiusKm: 1,
        gatherAt: new Date(start.getTime() - HOUR / 2).toISOString(),
        slots: 10,
        leaderUserId: CM,
        reportIds,
      },
    ],
    ...overrides,
  };
}

async function reportState(id: string) {
  return prisma.report.findUnique({
    where: { id },
    select: { campaignId: true, status: true },
  });
}

beforeEach(async () => {
  await resetTables();
  notify.mockClear();
  orgId = await seedOrganization();
});

afterAll(async () => {
  await resetTables();
});

describe("draft and submit", () => {
  it("a draft locks nothing; submitting locks the reports", async () => {
    const report = await seedReport();
    const draft = await campaignService.createCampaign(CM, draftRequest([report.id]) as never);
    expect(draft.status).toBe(S.DRAFT);
    expect(draft.meetingPoints).toHaveLength(1);
    expect(await reportState(report.id)).toEqual({
      campaignId: null,
      status: ReportStatus._STATUS_TODO,
    });
    // The draft still shows what was picked.
    const reread = await campaignService.getCampaignById(draft.id, CM);
    expect(reread?.reports.map((r) => r.id)).toEqual([report.id]);

    const submitted = await campaignService.submitCampaign(draft.id, CM);
    expect(submitted.status).toBe(S.PENDING_REVIEW);
    expect(await reportState(report.id)).toEqual({
      campaignId: draft.id,
      status: ReportStatus._STATUS_INPROCESS,
    });
    const log = await prisma.campaignStatusLog.findMany({ where: { campaignId: draft.id } });
    expect(log).toEqual([
      expect.objectContaining({ event: "submit", fromStatus: S.DRAFT, toStatus: S.PENDING_REVIEW }),
    ]);
    await eventually(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "CAMPAIGN_CREATED", userIds: [OWNER] }),
      ),
    );
  });

  it("two drafts racing for one report: one wins, the other gets 409 naming it", async () => {
    const report = await seedReport();
    const a = await campaignService.createCampaign(CM, draftRequest([report.id]) as never);
    const b = await campaignService.createCampaign(OWNER, draftRequest([report.id]) as never);
    await campaignService.submitCampaign(a.id, CM);
    await expect(campaignService.submitCampaign(b.id, OWNER)).rejects.toMatchObject({
      statusResponse: expect.objectContaining({ code: "CAMPAIGN_INVALID" }),
      data: {
        details: [expect.objectContaining({ code: "REPORT_UNAVAILABLE" })],
      },
    });
    expect((await prisma.campaign.findUnique({ where: { id: b.id } }))?.status).toBe(S.DRAFT);
  });

  it("submit returns every problem at once", async () => {
    const draft = await campaignService.createCampaign(
      CM,
      { organizationId: orgId, title: "Short", difficulty: 1 } as never,
    );
    await expect(campaignService.submitCampaign(draft.id, CM)).rejects.toMatchObject({
      data: {
        details: expect.arrayContaining([
          expect.objectContaining({ field: "title" }),
          expect.objectContaining({ field: "description" }),
          expect.objectContaining({ field: "banner" }),
          expect.objectContaining({ field: "startDate" }),
          expect.objectContaining({ field: "contactName" }),
          expect.objectContaining({ field: "meetingPoints" }),
        ]),
      },
    });
  });

  it("an unverified organization is held to the lowest difficulty", async () => {
    await prisma.organization.update({ where: { id: orgId }, data: { trustTier: "BASIC" } });
    const report = await seedReport();
    const draft = await campaignService.createCampaign(
      CM,
      draftRequest([report.id], { difficulty: 2 }) as never,
    );
    await expect(campaignService.submitCampaign(draft.id, CM)).rejects.toMatchObject({
      data: { details: [expect.objectContaining({ code: "DIFFICULTY_NOT_ALLOWED" })] },
    });
  });

  it("at most 3 campaigns under review per organization", async () => {
    for (let i = 0; i < 3; i++) {
      const report = await seedReport(0.001 * (i + 1));
      const d = await campaignService.createCampaign(CM, draftRequest([report.id]) as never);
      await campaignService.submitCampaign(d.id, CM);
    }
    const report = await seedReport(0.005);
    const fourth = await campaignService.createCampaign(CM, draftRequest([report.id]) as never);
    await expect(campaignService.submitCampaign(fourth.id, CM)).rejects.toMatchObject({
      statusResponse: expect.objectContaining({ code: "CAMPAIGN_CREATE_NOT_ALLOWED" }),
      data: { reasons: ["REVIEW_QUEUE_FULL"] },
    });
  });

  it("status cannot be written through update", async () => {
    const draft = await campaignService.createCampaign(CM, draftRequest([]) as never);
    await campaignService.updateCampaign(draft.id, CM, { status: S.ACTIVE } as never);
    expect((await prisma.campaign.findUnique({ where: { id: draft.id } }))?.status).toBe(S.DRAFT);
  });

  it("edits under review move the locks and are logged", async () => {
    const [r1, r2] = [await seedReport(0.001), await seedReport(0.002)];
    const draft = await campaignService.createCampaign(CM, draftRequest([r1.id]) as never);
    await campaignService.submitCampaign(draft.id, CM);
    await campaignService.updateCampaign(draft.id, CM, {
      meetingPoints: draftRequest([r2.id]).meetingPoints,
    } as never);
    expect((await reportState(r1.id))?.campaignId).toBeNull();
    expect((await reportState(r2.id))?.campaignId).toBe(draft.id);
    const edit = await prisma.campaignStatusLog.findFirst({
      where: { campaignId: draft.id, type: "EDIT" },
    });
    expect(edit?.changes).toHaveProperty("meetingPoints");
  });
});

describe("admin review", () => {
  async function pending() {
    const report = await seedReport();
    const draft = await campaignService.createCampaign(CM, draftRequest([report.id]) as never);
    await campaignService.submitCampaign(draft.id, CM);
    notify.mockClear();
    return { campaignId: draft.id, reportId: report.id };
  }

  it("approve → ACTIVE, reports stay locked, members told", async () => {
    const { campaignId, reportId } = await pending();
    const approved = await campaignService.reviewCampaign(campaignId, ADMIN, "approve", null);
    expect(approved.status).toBe(S.ACTIVE);
    expect((await reportState(reportId))?.campaignId).toBe(campaignId);
    await eventually(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "CAMPAIGN_APPROVED",
          userIds: expect.arrayContaining([OWNER, CM]),
        }),
      ),
    );
  });

  it("request changes keeps the lock for 7 days; resubmit records what changed", async () => {
    const { campaignId, reportId } = await pending();
    const back = await campaignService.reviewCampaign(
      campaignId,
      ADMIN,
      "request_revision",
      "Giờ tập trung chưa rõ",
    );
    expect(back.status).toBe(S.NEEDS_REVISION);
    expect(back.rejectReason).toBe("Giờ tập trung chưa rõ");
    expect(back.revisionDeadline!.getTime()).toBeGreaterThan(Date.now() + 6.9 * 24 * HOUR);
    expect((await reportState(reportId))?.campaignId).toBe(campaignId);

    await campaignService.updateCampaign(campaignId, CM, {
      safetyNotes: "Mang găng tay",
    } as never);
    const again = await campaignService.submitCampaign(campaignId, CM);
    expect(again.status).toBe(S.PENDING_REVIEW);
    const resubmit = await prisma.campaignStatusLog.findFirst({
      where: { campaignId, event: "resubmit" },
    });
    expect(resubmit?.changes).toEqual({
      safetyNotes: { from: null, to: "Mang găng tay" },
    });
  });

  it("block → BLOCKED for good, reports released, creator and owner told", async () => {
    const { campaignId, reportId } = await pending();
    const blocked = await campaignService.reviewCampaign(campaignId, ADMIN, "block", "Nội dung giả");
    expect(blocked.status).toBe(S.BLOCKED);
    expect(await reportState(reportId)).toEqual({
      campaignId: null,
      status: ReportStatus._STATUS_TODO,
    });
    await expect(
      campaignService.reviewCampaign(campaignId, ADMIN, "approve", null),
    ).rejects.toMatchObject(code("CAMPAIGN_INVALID_TRANSITION"));
    await eventually(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "CAMPAIGN_BLOCKED",
          userIds: expect.arrayContaining([CM, OWNER]),
          payload: expect.objectContaining({ reason: "Nội dung giả" }),
        }),
      ),
    );
  });

  it("an admin who belongs to the organization cannot review it", async () => {
    const { campaignId } = await pending();
    await expect(
      campaignService.reviewCampaign(campaignId, OWNER, "approve", null),
    ).rejects.toMatchObject(code("CAMPAIGN_REVIEW_CONFLICT_OF_INTEREST"));
  });

  it("the review queue hides organizations the admin belongs to", async () => {
    const { campaignId } = await pending();
    const mine = await campaignService.getCampaigns(
      { status: S.PENDING_REVIEW, excludeMemberOrgsOfUserId: OWNER },
      OWNER,
    );
    expect(mine.campaigns.map((c) => c.id)).not.toContain(campaignId);
    const other = await campaignService.getCampaigns(
      { status: S.PENDING_REVIEW, excludeMemberOrgsOfUserId: ADMIN },
      ADMIN,
    );
    expect(other.campaigns.map((c) => c.id)).toContain(campaignId);
  });

  it("drafts and campaigns under review are hidden from the public", async () => {
    const { campaignId } = await pending();
    const outsider = randomUUID();
    expect(await campaignService.getCampaignById(campaignId, outsider)).toBeNull();
    const managerView = await campaignService.getCampaignById(campaignId, CM);
    expect(managerView?.contactPhone).toBe("0901234567");
    const pub = await campaignService.getCampaigns({ publicOnly: true }, outsider);
    expect(pub.campaigns).toHaveLength(0);
  });
});

describe("lifecycle sweep", () => {
  it("expires reviews past their start or revision deadline, deletes stale drafts", async () => {
    const report = await seedReport();
    const draft = await campaignService.createCampaign(CM, draftRequest([report.id]) as never);
    await campaignService.submitCampaign(draft.id, CM);
    await prisma.campaign.update({
      where: { id: draft.id },
      data: { startDate: new Date(Date.now() - HOUR) },
    });

    const stale = await campaignService.createCampaign(CM, draftRequest([]) as never);
    await prisma.$executeRaw`UPDATE "campaigns" SET "updated_at" = NOW() - INTERVAL '31 days' WHERE "id" = ${stale.id}::uuid`;

    expect(await campaignLifecycleService.expireOverdue()).toBe(1);
    expect(await campaignLifecycleService.deleteStaleDrafts()).toBe(1);

    const expired = await prisma.campaign.findUnique({ where: { id: draft.id } });
    expect(expired?.status).toBe(S.EXPIRED);
    expect((await reportState(report.id))?.campaignId).toBeNull();
    expect((await prisma.campaign.findUnique({ where: { id: stale.id } }))?.deletedAt).not.toBeNull();
    await eventually(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "CAMPAIGN_EXPIRED", userIds: [CM] }),
      ),
    );
  });

  it("a campaign waiting for changes expires after 7 days", async () => {
    const report = await seedReport();
    const draft = await campaignService.createCampaign(CM, draftRequest([report.id]) as never);
    await campaignService.submitCampaign(draft.id, CM);
    await campaignService.reviewCampaign(draft.id, ADMIN, "request_revision", "Sửa lại");
    await prisma.campaign.update({
      where: { id: draft.id },
      data: { revisionDeadline: new Date(Date.now() - 1000) },
    });
    expect(await campaignLifecycleService.expireOverdue()).toBe(1);
    expect((await prisma.campaign.findUnique({ where: { id: draft.id } }))?.status).toBe(
      S.EXPIRED,
    );
  });
});

describe("after approval", () => {
  it("only free fields may change, and the campaign can no longer be deleted", async () => {
    const report = await seedReport();
    const draft = await campaignService.createCampaign(CM, draftRequest([report.id]) as never);
    await campaignService.submitCampaign(draft.id, CM);
    await campaignService.reviewCampaign(draft.id, ADMIN, "approve", null);

    await campaignService.updateCampaign(draft.id, CM, { safetyNotes: "Mang ủng" } as never);
    await expect(
      campaignService.updateCampaign(draft.id, CM, { title: "Tên mới cho chiến dịch" } as never),
    ).rejects.toMatchObject(code("CAMPAIGN_NOT_EDITABLE"));
    await expect(campaignService.deleteCampaign(draft.id, OWNER)).rejects.toMatchObject(
      code("CAMPAIGN_NOT_DELETABLE"),
    );
  });
});
