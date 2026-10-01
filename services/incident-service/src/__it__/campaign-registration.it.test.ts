/**
 * Per-shift registration (Đặc tả luồng chiến dịch 3.1), against a real Postgres.
 *
 *   - registering is immediate, never capped, several shifts a day allowed
 *   - overlaps, absences and full shifts only warn
 *   - only open shifts of an upcoming / running campaign, with the conditions accepted
 *   - unticking a shift leaves it; within 24 h of its start that is a late leave
 *   - managers get one digest a day, not one notification per registration
 *
 * identity and notification clients are mocked; the DB is real.
 */

jest.mock("../modules/organization/identity-user.client", () => ({
  fetchOrganizationOwnersByUserIds: async () => new Map(),
  getUserProfile: () => undefined,
  fetchUserIdsNearPoint: async () => [],
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
}));

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { CampaignStatus } from "@da2/constants";
import { prisma } from "./setup/test-db";
import { campaignRegistrationService } from "../modules/campaign/campaign_registration/campaign_registration.service";
import {
  digestCutoff,
  sendRegistrationDigests,
} from "../modules/campaign/campaign_registration/registration-digest";

const S = CampaignStatus;
const HOUR = 60 * 60 * 1000;
const CM = randomUUID();
const VOL = randomUUID();

let orgId: string;

const code = (c: string) => ({ statusResponse: expect.objectContaining({ code: c }) });

async function resetTables(): Promise<void> {
  await prisma.$executeRaw(
    Prisma.sql`TRUNCATE TABLE "outbox_events", "organizations", "campaigns" RESTART IDENTITY CASCADE`,
  );
}

/**
 * A campaign with one day starting `startInHours` from now and two meeting points; the second
 * shift starts an hour later. Shift A: min 2, max 3. Shift B: min 1, no max.
 */
async function seedCampaign(opts: { startInHours?: number; status?: number } = {}) {
  const start = new Date(Date.now() + (opts.startInHours ?? 72) * HOUR);
  const end = new Date(start.getTime() + 4 * HOUR);
  const campaign = await prisma.campaign.create({
    data: {
      title: `Campaign ${randomUUID().slice(0, 8)}`,
      status: opts.status ?? S.UPCOMING,
      organizationId: orgId,
      createdBy: CM,
      latitude: 10.77,
      longitude: 106.7,
      campaignManagers: { create: { userId: CM, assignedBy: CM } },
    },
  });
  const day = await prisma.campaignDay.create({
    data: { campaignId: campaign.id, startAt: start, endAt: end },
  });
  const point = (sortOrder: number) =>
    prisma.campaignMeetingPoint.create({
      data: { campaignId: campaign.id, latitude: 10.77, longitude: 106.7, radiusKm: 1, sortOrder },
    });
  const [p1, p2] = [await point(0), await point(1)];
  const a = await prisma.campaignShift.create({
    data: {
      campaignId: campaign.id,
      dayId: day.id,
      meetingPointId: p1.id,
      startAt: start,
      endAt: end,
      minVolunteers: 2,
      maxVolunteers: 3,
    },
  });
  const b = await prisma.campaignShift.create({
    data: {
      campaignId: campaign.id,
      dayId: day.id,
      meetingPointId: p2.id,
      startAt: new Date(start.getTime() + HOUR),
      endAt: end,
      minVolunteers: 1,
    },
  });
  return { id: campaign.id, shiftA: a.id, shiftB: b.id, dayStart: start };
}

const register = (campaignId: string, userId: string, shiftIds: string[]) =>
  campaignRegistrationService.setMyShifts(campaignId, userId, {
    shiftIds,
    acceptConditions: true,
  });

beforeEach(async () => {
  await resetTables();
  notify.mockClear();
  const org = await prisma.organization.create({
    data: {
      name: `Org ${randomUUID()}`,
      slug: `org-${randomUUID()}`,
      logoUrl: "https://example.com/logo.png",
      status: 1,
      members: {
        create: [
          { userId: randomUUID(), role: "OWNER", source: "INTERNAL" },
          { userId: CM, role: "CAMPAIGN_MANAGER", source: "INTERNAL" },
        ],
      },
    },
  });
  orgId = org.id;
});

afterAll(async () => {
  await resetTables();
});

describe("registering", () => {
  it("takes effect at once, for several shifts of one day, with no cap", async () => {
    const c = await seedCampaign();
    const mine = await register(c.id, VOL, [c.shiftA, c.shiftB]);
    expect(mine.shiftIds.sort()).toEqual([c.shiftA, c.shiftB].sort());
    // The two shifts overlap each other: a warning, not a refusal.
    expect(mine.warnings).toContain("OVERLAP");

    for (let i = 0; i < 3; i += 1) await register(c.id, randomUUID(), [c.shiftA]);
    const over = await register(c.id, randomUUID(), [c.shiftA]);
    expect(over.warnings).toContain("OVER_MAX");

    const options = await campaignRegistrationService.getOptions(c.id, VOL);
    const a = options.shifts.find((s) => s.id === c.shiftA);
    expect(a).toMatchObject({ registeredCount: 5, overMax: true, shortBy: 0, registeredByMe: true });
    expect(options.shifts.find((s) => s.id === c.shiftB)).toMatchObject({ shortBy: 0 });
  });

  it("needs the participation conditions accepted", async () => {
    const c = await seedCampaign();
    await expect(
      campaignRegistrationService.setMyShifts(c.id, VOL, { shiftIds: [c.shiftA] }),
    ).rejects.toMatchObject(code("CONDITIONS_NOT_ACCEPTED"));
  });

  it("only open shifts of an upcoming or running campaign", async () => {
    const pending = await seedCampaign({ status: S.PENDING_REVIEW });
    await expect(register(pending.id, VOL, [pending.shiftA])).rejects.toMatchObject(
      code("CAMPAIGN_NOT_REGISTRABLE"),
    );
    expect((await campaignRegistrationService.getOptions(pending.id, VOL)).reason).toBe("STATUS");

    const running = await seedCampaign({ status: S.ACTIVE, startInHours: -0.5 });
    await expect(register(running.id, VOL, [running.shiftA])).rejects.toMatchObject(
      code("SHIFT_NOT_REGISTRABLE"),
    );
    // Shift B starts an hour after the day: still open.
    await register(running.id, VOL, [running.shiftB]);

    await prisma.campaignShift.update({ where: { id: running.shiftB }, data: { minVolunteers: 0 } });
    const options = await campaignRegistrationService.getOptions(running.id, randomUUID());
    expect(options).toMatchObject({ registrable: false, reason: "NO_SHIFT", shifts: [] });
  });

  it("warns about an overlap with another campaign", async () => {
    const first = await seedCampaign();
    const second = await seedCampaign();
    await register(first.id, VOL, [first.shiftA]);
    const options = await campaignRegistrationService.getOptions(second.id, VOL);
    expect(options.shifts.find((s) => s.id === second.shiftA)?.conflicts).toEqual([
      expect.objectContaining({ campaignId: first.id, shiftId: first.shiftA }),
    ]);
    expect((await register(second.id, VOL, [second.shiftA])).warnings).toContain("OVERLAP");
  });
});

describe("leaving", () => {
  it("unticking leaves; within 24 h it is a late leave; [] leaves the campaign", async () => {
    const soon = await seedCampaign({ startInHours: 10 });
    await register(soon.id, VOL, [soon.shiftA, soon.shiftB]);
    const result = await register(soon.id, VOL, [soon.shiftB]);
    expect(result).toMatchObject({ shiftIds: [soon.shiftB], left: [soon.shiftA], lateLeft: [soon.shiftA] });

    const later = await seedCampaign({ startInHours: 72 });
    await register(later.id, VOL, [later.shiftA]);
    expect(await register(later.id, VOL, [])).toMatchObject({ shiftIds: [], lateLeft: [] });

    const rows = await prisma.campaignShiftRegistration.findMany({
      where: { userId: VOL, leftAt: { not: null } },
      select: { shiftId: true, lateLeave: true },
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        { shiftId: soon.shiftA, lateLeave: true },
        { shiftId: later.shiftA, lateLeave: false },
      ]),
    );
    // A left shift can be taken again.
    expect((await register(later.id, VOL, [later.shiftA])).added).toEqual([later.shiftA]);
  });

  it("a shift that has started is kept", async () => {
    const running = await seedCampaign({ status: S.ACTIVE, startInHours: 2 });
    await register(running.id, VOL, [running.shiftA]);
    await prisma.campaignShift.update({
      where: { id: running.shiftA },
      data: { startAt: new Date(Date.now() - HOUR) },
    });
    expect((await register(running.id, VOL, [])).shiftIds).toEqual([running.shiftA]);
  });
});

describe("managers", () => {
  it("see each shift with its volunteers and their absences", async () => {
    // Three ended shifts in campaigns the volunteer never checked in to.
    for (let i = 0; i < 3; i += 1) {
      const past = await seedCampaign({ status: S.ACTIVE, startInHours: 10 });
      await register(past.id, VOL, [past.shiftA]);
      await prisma.campaignShift.update({
        where: { id: past.shiftA },
        data: { startAt: new Date(Date.now() - 5 * HOUR), endAt: new Date(Date.now() - HOUR) },
      });
    }
    const c = await seedCampaign();
    expect((await campaignRegistrationService.getOptions(c.id, VOL)).manyAbsences).toBe(true);
    const result = await register(c.id, VOL, [c.shiftA]);
    expect(result.warnings).toContain("MANY_ABSENCES");

    const shifts = await campaignRegistrationService.listForManager(c.id, CM);
    expect(shifts.find((s) => s.shiftId === c.shiftA)).toMatchObject({
      registeredCount: 1,
      volunteers: [expect.objectContaining({ userId: VOL, absenceCount: 3, lateLeaveCount: 0 })],
    });
    await expect(campaignRegistrationService.listForManager(c.id, VOL)).rejects.toMatchObject(
      code("CAMPAIGN_PERMISSION_DENIED"),
    );
  });

  it("get one digest a day with the count per campaign day", async () => {
    const c = await seedCampaign();
    await register(c.id, VOL, [c.shiftA]);
    await register(c.id, randomUUID(), [c.shiftB]);
    const left = randomUUID();
    await register(c.id, left, [c.shiftB]);
    await register(c.id, left, []);

    const cutoff = digestCutoff(new Date());
    await prisma.campaignShiftRegistration.updateMany({
      where: { campaignId: c.id },
      data: { createdAt: new Date(cutoff.getTime() - HOUR) },
    });

    expect(await sendRegistrationDigests(new Date(cutoff.getTime() - 60_000))).toBe(0);
    const after = new Date(cutoff.getTime() + 60_000);
    expect(await sendRegistrationDigests(after)).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "CAMPAIGN_REGISTRATION_DIGEST",
        userIds: [CM],
        payload: expect.objectContaining({ campaignId: c.id, total: "2", breakdown: expect.stringContaining(": +2") }),
      }),
    );
    expect(await sendRegistrationDigests(after)).toBe(0);
  });
});
