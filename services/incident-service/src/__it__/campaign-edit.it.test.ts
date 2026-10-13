/**
 * Editing an approved campaign (Đặc tả luồng chiến dịch 3.5), against a real Postgres.
 *
 *   - free fields (title included) and shift numbers are saved at once, with a log
 *   - new times for an existing day or shift are an important change, at least 48 h away
 *   - an important change sends the campaign back to review: registrations keep their ids,
 *     volunteers are told, new sign-ups wait, leaving still works, admins approve it again
 *   - removing a day removes its shifts and their registrations, and tells those volunteers
 *   - nothing changes once the campaign runs
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

/** The campaign's current state as an edit body, with ids, as the edit form sends it. */
async function editBody(campaignId: string) {
  const c = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: {
      days: { orderBy: { startAt: "asc" } },
      meetingPoints: { where: { deletedAt: null }, orderBy: { sortOrder: "asc" }, include: { reports: true } },
      shifts: true,
    },
  });
  return {
    title: c.title,
    description: c.description,
    days: c.days.map((d) => ({ id: d.id, startAt: d.startAt.toISOString(), endAt: d.endAt.toISOString() })),
    meetingPoints: c.meetingPoints.map((p) => ({
      id: p.id,
      name: p.name,
      latitude: p.latitude,
      longitude: p.longitude,
      radiusKm: p.radiusKm,
      detailAddress: p.detailAddress,
      reportIds: p.reports.map((r) => r.reportId),
    })),
    shifts: c.shifts.map((s) => ({
      dayIndex: c.days.findIndex((d) => d.id === s.dayId),
      meetingPointIndex: c.meetingPoints.findIndex((p) => p.id === s.meetingPointId),
      startAt: s.startAt.toISOString(),
      endAt: s.endAt.toISOString(),
      gatherAt: s.gatherAt?.toISOString() ?? null,
      minVolunteers: s.minVolunteers,
      maxVolunteers: s.maxVolunteers,
      leaderUserId: s.leaderUserId,
    })),
  };
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
        ],
      },
    },
  });
  orgId = org.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("free fields and shift numbers", () => {
  it("save at once with a log; the campaign stays upcoming and nobody is told", async () => {
    const c = await approvedCampaign();
    const body = await editBody(c.id);
    body.title = "Dọn rác kênh Nhiêu Lộc — đợt 2";
    body.shifts[0].maxVolunteers = 15;
    const res = await campaignService.updateCampaign(c.id, CM, body as never);

    expect(res.reReview).toBe(false);
    expect(await statusOf(c.id)).toBe(S.UPCOMING);
    const shift = await prisma.campaignShift.findUniqueOrThrow({ where: { id: c.shifts[0].id } });
    expect(shift.maxVolunteers).toBe(15);
    const log = await prisma.campaignStatusLog.findFirstOrThrow({
      where: { campaignId: c.id, type: "EDIT", event: "edit" },
    });
    expect(Object.keys(log.changes as object).sort()).toEqual(["shifts", "title"]);
    expect(await outboxKinds()).toEqual([]);
  });

  it("a running shift cannot drop to 0 volunteers; turning it off is its own action", async () => {
    const c = await approvedCampaign();
    const body = await editBody(c.id);
    body.shifts[0].minVolunteers = 0;
    await expect(campaignService.updateCampaign(c.id, CM, body as never)).rejects.toMatchObject(
      code("SHIFT_MIN_REQUIRED"),
    );
  });
});

describe("important fields", () => {
  it("new times for an existing day and its shift send it back to review; registrations stay", async () => {
    const c = await approvedCampaign();
    const body = await editBody(c.id);
    const later = (iso: string, hours: number) => new Date(new Date(iso).getTime() + hours * HOUR).toISOString();
    const shift = body.shifts.find((sh) => sh.dayIndex === 0)!;
    body.days[0] = { ...body.days[0], startAt: later(body.days[0].startAt, 2), endAt: later(body.days[0].endAt, 2) };
    shift.startAt = later(shift.startAt, 2);
    shift.endAt = later(shift.endAt, 2);
    shift.gatherAt = later(shift.startAt, -0.5);
    const res = await campaignService.updateCampaign(c.id, CM, body as never);

    expect(res.reReview).toBe(true);
    expect(await statusOf(c.id)).toBe(S.PENDING_REVIEW);
    const day = await prisma.campaignDay.findUniqueOrThrow({ where: { id: body.days[0].id } });
    expect(day.startAt.toISOString()).toBe(body.days[0].startAt);
    const saved = await prisma.campaignShift.findUniqueOrThrow({ where: { id: c.shifts[0].id } });
    expect(saved.startAt.toISOString()).toBe(shift.startAt);
    expect(saved.gatherAt?.toISOString()).toBe(shift.gatherAt);
    const regs = await prisma.campaignShiftRegistration.findMany({ where: { campaignId: c.id, leftAt: null } });
    expect(regs.map((r) => r.shiftId).sort()).toEqual(c.shifts.map((s) => s.id).sort());
    expect(await outboxKinds()).toEqual([
      expect.objectContaining({ kind: "CAMPAIGN_UPDATED_NEEDS_REVIEW", userIds: [VOL] }),
    ]);
  });

  it("an existing day cannot move to less than 48 hours from now", async () => {
    const c = await approvedCampaign();
    const body = await editBody(c.id);
    const soon = new Date(Date.now() + 24 * HOUR);
    body.days[0] = { ...body.days[0], startAt: soon.toISOString(), endAt: new Date(soon.getTime() + 4 * HOUR).toISOString() };
    await expect(campaignService.updateCampaign(c.id, CM, body as never)).rejects.toMatchObject(
      code("CAMPAIGN_INVALID"),
    );
    expect(await statusOf(c.id)).toBe(S.UPCOMING);
  });

  it("adding a waste point sends it back to review; registrations stay and volunteers hear", async () => {
    const c = await approvedCampaign();
    const extra = await seedReport(0.002);
    const body = await editBody(c.id);
    body.meetingPoints[0].reportIds.push(extra.id);
    const res = await campaignService.updateCampaign(c.id, CM, body as never);

    expect(res.reReview).toBe(true);
    expect(await statusOf(c.id)).toBe(S.PENDING_REVIEW);
    expect((await prisma.report.findUniqueOrThrow({ where: { id: extra.id } })).campaignId).toBe(c.id);
    const regs = await prisma.campaignShiftRegistration.findMany({ where: { campaignId: c.id, leftAt: null } });
    expect(regs.map((r) => r.shiftId).sort()).toEqual(c.shifts.map((s) => s.id).sort());
    expect(
      await prisma.campaignStatusLog.count({ where: { campaignId: c.id, event: "edit_major" } }),
    ).toBe(1);
    expect(await outboxKinds()).toEqual([
      expect.objectContaining({ kind: "CAMPAIGN_UPDATED_NEEDS_REVIEW", userIds: [VOL] }),
    ]);

    // Under review: the volunteer still sees it and may leave; nobody new may join.
    expect(await campaignService.getCampaignById(c.id, VOL)).not.toBeNull();
    expect(await campaignService.getCampaignById(c.id, VOL2)).toBeNull();
    await expect(
      campaignRegistrationService.setMyShifts(c.id, VOL2, {
        shiftIds: [c.shifts[0].id],
        acceptConditions: true,
      }),
    ).rejects.toMatchObject(code("CAMPAIGN_NOT_REGISTRABLE"));
    await campaignRegistrationService.setMyShifts(c.id, VOL, {
      shiftIds: [c.shifts[0].id],
      acceptConditions: true,
    });

    // Edited again while under review: still by id.
    const again = await editBody(c.id);
    again.description = again.description + "<p>Mang găng tay.</p>";
    await campaignService.updateCampaign(c.id, CM, again as never);
    expect(await statusOf(c.id)).toBe(S.PENDING_REVIEW);

    await campaignService.reviewCampaign(c.id, ADMIN, "approve", null);
    expect(await statusOf(c.id)).toBe(S.UPCOMING);
    expect(
      await prisma.campaignShiftRegistration.count({ where: { campaignId: c.id, userId: VOL, leftAt: null } }),
    ).toBe(1);
  });

  it("removing a day removes its shifts and registrations and tells those volunteers", async () => {
    const c = await approvedCampaign();
    const body = await editBody(c.id);
    body.days = [body.days[0]];
    body.shifts = body.shifts.filter((s) => s.dayIndex === 0);
    await campaignService.updateCampaign(c.id, CM, body as never);

    expect(await statusOf(c.id)).toBe(S.PENDING_REVIEW);
    expect(await prisma.campaignShift.count({ where: { id: c.shifts[1].id } })).toBe(0);
    expect(await prisma.campaignShiftRegistration.count({ where: { shiftId: c.shifts[1].id } })).toBe(0);
    expect(
      await prisma.campaignShiftRegistration.count({ where: { shiftId: c.shifts[0].id, leftAt: null } }),
    ).toBe(1);
    const kinds = (await outboxKinds()).map((e) => e.kind).sort();
    expect(kinds).toEqual(["CAMPAIGN_SHIFT_CLOSED", "CAMPAIGN_UPDATED_NEEDS_REVIEW"]);
  });
});

describe("a running campaign", () => {
  it("cannot be edited at all, not even its description", async () => {
    const c = await approvedCampaign();
    await prisma.campaign.update({ where: { id: c.id }, data: { status: S.ACTIVE } });
    await expect(
      campaignService.updateCampaign(c.id, CM, { description: "<p>Khác</p>" } as never),
    ).rejects.toMatchObject(code("CAMPAIGN_NOT_EDITABLE"));
  });
});
