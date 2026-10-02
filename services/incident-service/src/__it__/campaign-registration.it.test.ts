/**
 * Per-shift registration (Đặc tả luồng chiến dịch 3.1), against a real Postgres.
 *
 *   - registering is immediate, never capped, several shifts a day allowed
 *   - overlaps and full shifts only warn
 *   - only open shifts of an upcoming / running campaign, with the conditions accepted
 *   - unticking a shift leaves it, freely and with nothing recorded, until it starts
 *   - managers read the list, get one digest a day, hear about short and over-full shifts,
 *     re-invite nearby residents at most once a day and can turn a shift off (spec 3.2)
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
const nearby = jest.fn(async () => [] as string[]);
jest.mock("../modules/campaign/nearby-users", () => ({
  findNearbyUserIds: (...a: unknown[]) => nearby(...(a as [])),
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
import {
  sendOverMaxAlerts,
  sendUnderstaffedAlerts,
} from "../modules/campaign/campaign_registration/staffing-alerts";

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
  it("unticking leaves freely before the shift starts; [] leaves the campaign", async () => {
    const soon = await seedCampaign({ startInHours: 1 });
    await register(soon.id, VOL, [soon.shiftA, soon.shiftB]);
    const result = await register(soon.id, VOL, [soon.shiftB]);
    expect(result).toMatchObject({ shiftIds: [soon.shiftB], left: [soon.shiftA] });
    expect(await register(soon.id, VOL, [])).toMatchObject({ shiftIds: [] });

    const rows = await prisma.campaignShiftRegistration.findMany({
      where: { userId: VOL, leftAt: { not: null } },
      select: { shiftId: true, closedByShift: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r.closedByShift)).toBe(true);
    // A left shift can be taken again.
    expect((await register(soon.id, VOL, [soon.shiftA])).added).toEqual([soon.shiftA]);
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
  it("read who registered for each shift; registered volunteers too, others not", async () => {
    const c = await seedCampaign();
    await register(c.id, VOL, [c.shiftA]);

    const shifts = await campaignRegistrationService.listByShift(c.id, { userId: CM });
    expect(shifts.find((s) => s.shiftId === c.shiftA)).toMatchObject({
      registeredCount: 1,
      volunteers: [expect.objectContaining({ userId: VOL, checkedInAt: null })],
    });
    const seen = await campaignRegistrationService.listByShift(c.id, { userId: VOL });
    expect(seen.find((s) => s.shiftId === c.shiftA)?.registeredCount).toBe(1);
    await expect(
      campaignRegistrationService.listByShift(c.id, { userId: randomUUID() }),
    ).rejects.toMatchObject(code("CAMPAIGN_PERMISSION_DENIED"));
  });

  it("hear once about a day with short shifts, 72 h before it", async () => {
    const soon = await seedCampaign({ startInHours: 48 });
    await register(soon.id, VOL, [soon.shiftB]); // B is full (min 1), A is short (0/2)
    const far = await seedCampaign({ startInHours: 100 });

    expect(await sendUnderstaffedAlerts()).toBe(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "CAMPAIGN_SHIFT_UNDERSTAFFED",
        userIds: [CM],
        payload: expect.objectContaining({ campaignId: soon.id, shifts: expect.stringContaining("0/2") }),
      }),
    );
    expect(notify.mock.calls.some(([arg]) => (arg as { payload: { campaignId: string } }).payload.campaignId === far.id)).toBe(false);
    notify.mockClear();
    expect(await sendUnderstaffedAlerts()).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("hear when a shift goes over its expected maximum, again after it drops back", async () => {
    const c = await seedCampaign();
    const people = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const p of people) await register(c.id, p, [c.shiftA]); // max 3
    expect(await sendOverMaxAlerts()).toBe(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "CAMPAIGN_SHIFT_OVER_MAX", payload: expect.objectContaining({ registered: "4", max: "3" }) }),
    );
    expect(await sendOverMaxAlerts()).toBe(0);

    await register(c.id, people[0], []);
    expect(await sendOverMaxAlerts()).toBe(0); // back to 3: mark cleared
    await register(c.id, people[0], [c.shiftA]);
    expect(await sendOverMaxAlerts()).toBe(1);
  });

  it("re-invite nearby residents at most once a day, leaving out managers and volunteers", async () => {
    const c = await seedCampaign();
    await register(c.id, VOL, [c.shiftA]);
    const resident = randomUUID();
    nearby.mockResolvedValueOnce([resident]);

    expect(await campaignRegistrationService.inviteNearby(c.id, CM)).toEqual({ invited: 1 });
    const [, exclude] = nearby.mock.calls[0] as unknown as [unknown, string[]];
    expect(exclude).toEqual(expect.arrayContaining([CM, VOL]));
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "CAMPAIGN_JOIN_INVITE", userIds: [resident], payload: expect.objectContaining({ shortBy: "2" }) }),
    );
    await expect(campaignRegistrationService.inviteNearby(c.id, CM)).rejects.toMatchObject(
      code("NEARBY_INVITE_TOO_SOON"),
    );
    await expect(campaignRegistrationService.inviteNearby(c.id, VOL)).rejects.toMatchObject(
      code("CAMPAIGN_PERMISSION_DENIED"),
    );
  });

  it("a re-invite that could not be sent can be retried at once", async () => {
    const c = await seedCampaign();
    nearby.mockResolvedValueOnce([randomUUID()]);
    notify.mockRejectedValueOnce(new Error("notification-service down"));
    await expect(campaignRegistrationService.inviteNearby(c.id, CM)).rejects.toThrow("down");
    expect((await prisma.campaign.findUnique({ where: { id: c.id } }))?.lastNearbyInviteAt).toBeNull();

    nearby.mockResolvedValueOnce([randomUUID()]);
    expect(await campaignRegistrationService.inviteNearby(c.id, CM)).toEqual({ invited: 1 });
  });

  it("turn a shift off: its volunteers are let go and told; the last shift of a day stays", async () => {
    const c = await seedCampaign();
    await register(c.id, VOL, [c.shiftA]);

    await expect(campaignRegistrationService.closeShift(c.id, c.shiftA, VOL)).rejects.toMatchObject(
      code("CAMPAIGN_PERMISSION_DENIED"),
    );
    expect(await campaignRegistrationService.closeShift(c.id, c.shiftA, CM)).toEqual({ notified: 1 });
    expect(await prisma.campaignShift.findUnique({ where: { id: c.shiftA } })).toMatchObject({
      minVolunteers: 0,
      maxVolunteers: null,
    });
    expect(
      await prisma.campaignShiftRegistration.findFirst({ where: { shiftId: c.shiftA, userId: VOL } }),
    ).toMatchObject({ closedByShift: true, leftAt: expect.any(Date) });
    // The notice rides the outbox, so it survives notification-service being down.
    const outbox = await prisma.outboxEvent.findMany({ where: { eventType: "WEBSITE_NOTIFICATION" } });
    expect(outbox).toHaveLength(1);
    expect(outbox[0].payload).toMatchObject({ kind: "CAMPAIGN_SHIFT_CLOSED", userIds: [VOL] });
    expect(await prisma.campaignStatusLog.count({ where: { campaignId: c.id, event: "close_shift" } })).toBe(1);

    await expect(campaignRegistrationService.closeShift(c.id, c.shiftB, CM)).rejects.toMatchObject(
      code("DAY_NEEDS_ACTIVE_SHIFT"),
    );

    const started = await seedCampaign({ status: S.ACTIVE, startInHours: -0.5 });
    await expect(
      campaignRegistrationService.closeShift(started.id, started.shiftA, CM),
    ).rejects.toMatchObject(code("SHIFT_ALREADY_STARTED"));
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
