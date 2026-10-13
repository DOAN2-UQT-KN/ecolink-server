/**
 * Shift reminders (Đặc tả luồng chiến dịch-7, 3.7), against a real Postgres.
 *
 *   - 24 h and 1 h before each day's gathering time, once each, one per day
 *   - registering late only brings the 1-hour reminder
 *   - new times through an edit bring the reminders back; a cancelled campaign has none
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
import { sendShiftReminders } from "../modules/campaign/campaign_registration/shift-reminders";
import { enqueueWebsiteNotificationsToUsers } from "../modules/campaign/notification-jobs.client";

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


const enqueue = enqueueWebsiteNotificationsToUsers as jest.Mock;
const reminders = () =>
  enqueue.mock.calls
    .map(([job]) => job as { kind: string; userIds: string[]; payload: Record<string, string> })
    .filter((j) => j.kind === "CAMPAIGN_SHIFT_REMINDER");

/** `hours` before the first shift's gathering time (its start: none set). */
const before = (shift: { startAt: Date }, hours: number) => new Date(shift.startAt.getTime() - hours * HOUR);

beforeEach(() => enqueue.mockClear());

describe("shift reminders", () => {
  it("24 h and 1 h before the gathering time, once each", async () => {
    const c = await approvedCampaign();
    const first = c.shifts[0];
    expect(await sendShiftReminders(before(first, 30))).toBe(0);
    expect(await sendShiftReminders(before(first, 23))).toBe(1);
    expect(await sendShiftReminders(before(first, 22))).toBe(0);
    expect(await sendShiftReminders(before(first, 0.5))).toBe(1);
    expect(await sendShiftReminders(before(first, 0.25))).toBe(0);

    const sent = reminders();
    expect(sent.map((j) => [j.userIds, j.payload.hours])).toEqual([
      [[VOL], "24"],
      [[VOL], "1"],
    ]);
    expect(sent[0].payload).toMatchObject({ campaignId: c.id, meetingPoint: "#1" });
  });

  it("registering within 24 hours only brings the 1-hour reminder", async () => {
    const c = await approvedCampaign();
    const first = c.shifts[0];
    expect(await sendShiftReminders(before(first, 0.75))).toBe(1);
    expect(await sendShiftReminders(before(first, 0.5))).toBe(0);
    expect(reminders().map((j) => j.payload.hours)).toEqual(["1"]);
  });

  it("one reminder per day, at the earliest gathering time among the volunteer's shifts", async () => {
    const c = await approvedCampaign();
    const first = c.shifts[0];
    const point = await prisma.campaignMeetingPoint.create({
      data: { campaignId: c.id, latitude: POINT.latitude, longitude: POINT.longitude, radiusKm: 1, sortOrder: 1 },
    });
    const second = await prisma.campaignShift.create({
      data: {
        campaignId: c.id,
        dayId: first.dayId,
        meetingPointId: point.id,
        startAt: first.startAt,
        endAt: first.endAt,
        gatherAt: new Date(first.startAt.getTime() - HOUR),
        minVolunteers: 5,
        leaderUserId: CM,
      },
    });
    await prisma.campaignShiftRegistration.create({ data: { campaignId: c.id, shiftId: second.id, userId: VOL } });

    expect(await sendShiftReminders(before(first, 24.5))).toBe(1);
    expect(reminders()[0].payload).toMatchObject({ meetingPoint: "#2", hours: "24" });
  });

  it("new times through an edit bring the reminders back", async () => {
    const c = await approvedCampaign();
    await sendShiftReminders(before(c.shifts[0], 23));
    const body = await editBody(c.id);
    const later = (iso: string) => new Date(new Date(iso).getTime() + 2 * HOUR).toISOString();
    body.days[0] = { ...body.days[0], startAt: later(body.days[0].startAt), endAt: later(body.days[0].endAt) };
    const shift = body.shifts.find((sh) => sh.dayIndex === 0)!;
    shift.startAt = later(shift.startAt);
    shift.endAt = later(shift.endAt);
    await campaignService.updateCampaign(c.id, CM, body as never);
    // Back under review: no reminders meanwhile; approved again, they come back.
    expect(await sendShiftReminders(before(c.shifts[0], 22))).toBe(0);
    await campaignService.reviewCampaign(c.id, ADMIN, "approve", null);
    expect(await sendShiftReminders(before(c.shifts[0], 21))).toBe(1);
  });

  it("a cancelled campaign sends none", async () => {
    const c = await approvedCampaign();
    await campaignService.cancelCampaign(c.id, CM, "Huỷ");
    expect(await sendShiftReminders(before(c.shifts[0], 23))).toBe(0);
  });
});
