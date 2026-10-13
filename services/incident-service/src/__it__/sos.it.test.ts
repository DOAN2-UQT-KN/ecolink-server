/**
 * SOS v2 (spec "Ecolink – Cải tiến tính năng SOS"), against a real Postgres + PostGIS:
 *
 *   - who may raise one: a checked-in volunteer of a running shift, the leader, a manager, a
 *     resident within 500 m of a meeting point (verified email, phone); 3 per hour
 *   - details by type (hazard needs a photo, 1–20 people)
 *   - recipients at creation by priority: the team, owners + admins for medical (with email),
 *     "available" volunteers in the radius and their hours under the daily cap (medical not
 *     counted), hazard only warns, nearby organizations and admins at once for hazard / medical
 *   - the job: owners after 10 min, 5 km + priority 2 after 15 min, expiry, hazard to the admins
 *     after 2 h unless resolved
 *   - responders: helping / open, one SOS at a time, arrived within 50 m, no more invites once enough
 *   - resolve: the people on the way hear; 3 false alarms in 30 days go to the admins
 *   - privacy of the detail; a completed campaign resolves its live SOS
 *
 * identity, reward and notification clients are mocked; the DB is real. Time is passed in.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "./setup/test-db";

/** userId → identity profile; anyone else has a verified email and a phone. */
const mockProfiles = new Map<string, { emailVerified: boolean; phoneNumber: string | null }>();

jest.mock("../modules/organization/identity-user.client", () => ({
  fetchOrganizationOwnersByUserIds: async (ids: string[]) =>
    new Map(ids.map((id) => [id, { id, name: `Name ${id.slice(0, 4)}`, avatar: null, bio: null }])),
  getUserProfile: (m: Map<string, unknown>, id: string) => m.get(id),
  fetchUserIdsNearPoint: async () => [],
  fetchUserVoteProfile: async ({ userId }: { userId: string }) => ({
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    savedLocationDistanceM: null,
    ...(mockProfiles.get(userId) ?? { emailVerified: true, phoneNumber: "0901234567" }),
  }),
}));
jest.mock("../modules/reward/reward-service.client", () => {
  const tier = async (level: number) => ({ level, maxVolunteers: 20, suggestedMinVolunteers: 10, greenPoints: level * 10 });
  return {
    rewardServiceClient: { getDifficultyByLevel: tier, getDifficultyByLevelStrict: tier, getDifficulties: async () => [] },
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
}));

import { CampaignStatus } from "@da2/constants";
import { OutboxEventType } from "../outbox/outbox.types";
import { CAMPAIGN_INCLUDE } from "../modules/campaign/campaign.entity";
import { completeCampaign } from "../modules/campaign/campaign_verification/verification-decision.service";
import { resolveSosEligibility } from "../modules/sos/sos-eligibility";
import { sosAvailabilityService } from "../modules/sos/sos-availability.service";
import { runSosSweep } from "../modules/sos/sos.job";
import { sosController } from "../modules/sos/sos.controller";
import type { ValidationChain } from "express-validator";
import { sosService } from "../modules/sos/sos.service";
import type { CreateSosRequest } from "../modules/sos/sos.dto";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = new Date();
const ADMIN = randomUUID();
const code = (c: string) => ({ statusResponse: expect.objectContaining({ code: c }) });
const at = (ms: number) => new Date(NOW.getTime() + ms);
/** Degrees of latitude per km (roughly). */
const KM = 1 / 111;

let seedIndex = 0;

/**
 * An organization (OWNER, MGR) running a campaign with meeting points A (at the base) and B (~440 m
 * north), each with a shift from 1 h ago to `endInH` from now (or starting in an hour with
 * `future`), led by LEADER. V and V2 are checked in on shift A. Each seed sits ~55 km from the
 * others so radius queries never see another test's data. OTHER_OWNER's organization has an
 * upcoming campaign whose meeting point is 1 km away.
 */
async function seed(opts: { endInH?: number; future?: boolean } = {}) {
  seedIndex += 1;
  const base = { latitude: 15 + seedIndex * 0.5, longitude: 108.2 };
  const ids = {
    OWNER: randomUUID(),
    MGR: randomUUID(),
    LEADER: randomUUID(),
    V: randomUUID(),
    V2: randomUUID(),
    OTHER_OWNER: randomUUID(),
  };
  const org = await prisma.organization.create({
    data: {
      name: `Org ${randomUUID()}`,
      slug: `org-${randomUUID()}`,
      logoUrl: "https://example.com/logo.png",
      status: 1,
      members: {
        create: [
          { userId: ids.OWNER, role: "OWNER", source: "INTERNAL" },
          { userId: ids.MGR, role: "CAMPAIGN_MANAGER", source: "INTERNAL" },
        ],
      },
    },
  });
  const start = opts.future ? at(HOUR) : at(-HOUR);
  const end = at((opts.endInH ?? 3) * HOUR);
  const campaign = await prisma.campaign.create({
    data: {
      title: "Dọn rác bãi biển",
      status: CampaignStatus.ACTIVE,
      organizationId: org.id,
      createdBy: ids.MGR,
      contactName: "Chị Lan",
      contactPhone: "0911000111",
      safetyNotes: "Mang găng tay",
      ...base,
      campaignManagers: { create: [{ userId: ids.MGR, assignedBy: ids.OWNER }] },
    },
  });
  const day = await prisma.campaignDay.create({ data: { campaignId: campaign.id, startAt: start, endAt: end } });
  const pointA = await prisma.campaignMeetingPoint.create({
    data: { campaignId: campaign.id, name: "A", ...base, radiusKm: 1, sortOrder: 0 },
  });
  const pointB = await prisma.campaignMeetingPoint.create({
    data: { campaignId: campaign.id, name: "B", latitude: base.latitude + 0.004, longitude: base.longitude, radiusKm: 1, sortOrder: 1 },
  });
  const shift = (meetingPointId: string) =>
    prisma.campaignShift.create({
      data: { campaignId: campaign.id, dayId: day.id, meetingPointId, startAt: start, endAt: end, minVolunteers: 5, leaderUserId: ids.LEADER },
    });
  const shiftA = await shift(pointA.id);
  const shiftB = await shift(pointB.id);
  if (!opts.future) {
    await prisma.campaignShiftAttendance.createMany({
      data: [ids.V, ids.V2].map((userId) => ({
        campaignId: campaign.id,
        shiftId: shiftA.id,
        userId,
        checkInAt: at(-30 * MIN),
        preRegistered: true,
      })),
    });
  }
  // Another organization nearby: an upcoming campaign with a meeting point 1 km away.
  const other = await prisma.organization.create({
    data: {
      name: `Other ${randomUUID()}`,
      slug: `other-${randomUUID()}`,
      logoUrl: "https://example.com/logo.png",
      status: 1,
      members: { create: [{ userId: ids.OTHER_OWNER, role: "OWNER", source: "INTERNAL" }] },
    },
  });
  const otherCampaign = await prisma.campaign.create({
    data: { title: "Other", status: CampaignStatus.UPCOMING, organizationId: other.id, createdBy: ids.OTHER_OWNER },
  });
  await prisma.campaignMeetingPoint.create({
    data: { campaignId: otherCampaign.id, latitude: base.latitude + KM, longitude: base.longitude, radiusKm: 1 },
  });
  return { ...ids, base, campaign, pointA, pointB, shiftA, shiftB, start, end };
}
type Seed = Awaited<ReturnType<typeof seed>>;

const manpower = (s: Seed, extra: Partial<CreateSosRequest> = {}): CreateSosRequest => ({
  campaignId: s.campaign.id,
  type: "manpower",
  details: { peopleNeeded: 2 },
  ...extra,
});
const medical = (s: Seed): CreateSosRequest => ({
  campaignId: s.campaign.id,
  type: "medical",
  details: { consciousness: "unconscious", affected: 1 },
});
const hazard = (s: Seed): CreateSosRequest => ({
  campaignId: s.campaign.id,
  type: "hazard",
  details: { hazardKinds: ["needles"] },
  photoUrls: ["https://res.cloudinary.com/demo/image/upload/needles.jpg"],
});

/** An "available" volunteer `km` north of the seed's base. */
async function available(s: Seed, km: number, schedule: unknown[] = []) {
  const userId = randomUUID();
  await sosAvailabilityService.update(userId, { enabled: true, schedule: schedule as never });
  await sosAvailabilityService.updateLocation(userId, { latitude: s.base.latitude + km * KM, longitude: s.base.longitude });
  return userId;
}

async function notices(sosId: number) {
  const rows = await prisma.outboxEvent.findMany({
    where: { eventType: OutboxEventType.WEBSITE_NOTIFICATION },
    orderBy: { createdAt: "asc" },
  });
  return rows
    .map((r) => r.payload as { kind: string; userIds: string[]; payload: Record<string, string>; email?: boolean })
    .filter((n) => n.payload.sosId === String(sosId));
}
const usersOf = async (sosId: number, kind: string) =>
  (await notices(sosId)).filter((n) => n.kind === kind).flatMap((n) => n.userIds);

beforeAll(() => {
  process.env.CAMPAIGN_ADMIN_NOTIFY_USER_IDS = ADMIN;
});

describe("who may raise an SOS", () => {
  it("a checked-in volunteer may; one not checked in, or with no running shift, may not", async () => {
    const s = await seed();
    const sos = await sosService.create(manpower(s), { userId: s.V }, NOW);
    expect(sos).toMatchObject({ reporterRole: "volunteer", shiftId: s.shiftA.id, meetingPointId: s.pointA.id, state: "open" });
    // No GPS: at the meeting point, with the phone of the profile.
    expect(sos).toMatchObject({ latitude: s.pointA.latitude, longitude: s.pointA.longitude, phone: null });
    expect((await prisma.sos.findUniqueOrThrow({ where: { id: sos.id } })).phone).toBe("0901234567");

    const stranger = randomUUID();
    await expect(sosService.create(manpower(s), { userId: stranger }, NOW)).rejects.toMatchObject(code("SOS_NOT_ELIGIBLE"));
    expect((await resolveSosEligibility(s.campaign.id, stranger, {}, NOW)).reason).toBe("location_required");

    const later = await seed({ future: true });
    const elig = await resolveSosEligibility(later.campaign.id, later.MGR, {}, NOW);
    expect(elig).toMatchObject({ canRaise: false, reason: "no_running_shift" });
    await expect(sosService.create(manpower(later), { userId: later.MGR }, NOW)).rejects.toMatchObject(
      code("SOS_NOT_ELIGIBLE"),
    );

    // The leader and a manager: the leader's shifts, every running shift.
    expect((await resolveSosEligibility(s.campaign.id, s.LEADER, {}, NOW)).role).toBe("leader");
    const mgr = await resolveSosEligibility(s.campaign.id, s.MGR, {}, NOW);
    expect(mgr.role).toBe("manager");
    expect(mgr.shifts.map((x) => x.id).sort()).toEqual([s.shiftA.id, s.shiftB.id].sort());
  });

  it("a resident: within 500 m with a verified email, tied to the nearest meeting point", async () => {
    const s = await seed();
    const resident = randomUUID();
    const far = { latitude: s.base.latitude - 0.01, longitude: s.base.longitude };
    expect((await resolveSosEligibility(s.campaign.id, resident, far, NOW)).reason).toBe("too_far");
    await expect(
      sosService.create(manpower(s, far), { userId: resident }, NOW),
    ).rejects.toMatchObject(code("SOS_NOT_ELIGIBLE"));

    // ~110 m from B, ~330 m from A.
    const near = { latitude: s.base.latitude + 0.003, longitude: s.base.longitude };
    const sos = await sosService.create(manpower(s, near), { userId: resident }, NOW);
    expect(sos).toMatchObject({ reporterRole: "resident", meetingPointId: s.pointB.id, shiftId: s.shiftB.id, latitude: near.latitude });

    const unverified = randomUUID();
    mockProfiles.set(unverified, { emailVerified: false, phoneNumber: "0900000000" });
    expect((await resolveSosEligibility(s.campaign.id, unverified, near, NOW)).reason).toBe("email_unverified");
    const noPhone = randomUUID();
    mockProfiles.set(noPhone, { emailVerified: true, phoneNumber: null });
    expect((await resolveSosEligibility(s.campaign.id, noPhone, near, NOW)).reason).toBe("phone_missing");
  });

  it("no hourly limit by default", async () => {
    const s = await seed();
    for (let i = 0; i < 4; i++) {
      await sosService.create(manpower(s), { userId: s.V }, at(i * MIN));
    }
    expect((await resolveSosEligibility(s.campaign.id, s.V, {}, at(4 * MIN))).hourlyRemaining).toBeNull();
  });

  it("with SOS_MAX_PER_HOUR=3, the 4th SOS within an hour is refused", async () => {
    const previous = process.env.SOS_MAX_PER_HOUR;
    process.env.SOS_MAX_PER_HOUR = "3";
    try {
      const s = await seed();
      for (let i = 0; i < 3; i++) {
        await sosService.create(manpower(s), { userId: s.V }, at(i * MIN));
      }
      expect((await resolveSosEligibility(s.campaign.id, s.V, {}, at(3 * MIN))).hourlyRemaining).toBe(0);
      await expect(sosService.create(manpower(s), { userId: s.V }, at(3 * MIN))).rejects.toMatchObject(
        code("SOS_RATE_LIMIT"),
      );
      // An hour after the first, one more is allowed.
      await expect(sosService.create(manpower(s), { userId: s.V }, at(61 * MIN))).resolves.toBeDefined();
    } finally {
      if (previous === undefined) delete process.env.SOS_MAX_PER_HOUR;
      else process.env.SOS_MAX_PER_HOUR = previous;
    }
  });
});

describe("details by type", () => {
  it("hazard needs a photo; people needed is 1–20", async () => {
    const s = await seed();
    await expect(
      sosService.create({ ...hazard(s), photoUrls: [] }, { userId: s.V }, NOW),
    ).rejects.toMatchObject(code("SOS_PHOTO_REQUIRED"));
    await expect(
      sosService.create(manpower(s, { details: { peopleNeeded: 21 } }), { userId: s.V }, NOW),
    ).rejects.toMatchObject(code("SOS_DETAILS_INVALID"));
    await expect(
      sosService.create(manpower(s, { details: {} }), { userId: s.V }, NOW),
    ).rejects.toMatchObject(code("SOS_DETAILS_INVALID"));
    await expect(
      sosService.create({ ...medical(s), details: { consciousness: "conscious", affected: 0 } }, { userId: s.V }, NOW),
    ).rejects.toMatchObject(code("SOS_DETAILS_INVALID"));
    const ok = await sosService.create(
      manpower(s, { details: { tools: ["bags", "shovel"], toolsNote: "20 bao" } }),
      { userId: s.V },
      NOW,
    );
    expect(ok.details).toEqual({ peopleNeeded: null, tools: ["bags", "shovel"], toolsNote: "20 bao" });
  });

  it("hazard takes one or more kinds; the old single kind still works", async () => {
    const s = await seed();
    const two = await sosService.create(
      { ...hazard(s), details: { hazardKinds: ["needles", "chemicals", "needles"] } },
      { userId: s.V },
      NOW,
    );
    expect(two.details).toEqual({ hazardKinds: ["needles", "chemicals"] });
    for (const details of [{ hazardKinds: [] }, { hazardKinds: ["needles", "lava"] }, {}]) {
      await expect(sosService.create({ ...hazard(s), details }, { userId: s.V }, NOW)).rejects.toMatchObject(
        code("SOS_DETAILS_INVALID"),
      );
    }
    const legacy = await sosService.create({ ...hazard(s), details: { hazardKind: "chemicals" } }, { userId: s.V }, NOW);
    expect(legacy.details).toEqual({ hazardKinds: ["chemicals"] });
  });
});

describe("recipients at creation", () => {
  /** Local weekday (Asia/Ho_Chi_Minh) of NOW. */
  const localDay = new Date(NOW.getTime() + 7 * HOUR).getUTCDay();

  async function capped(s: Seed, userId: string) {
    const dummy = await prisma.sos.create({
      data: { campaignId: s.campaign.id, type: "manpower", address: "", latitude: 0, longitude: 0, createdAt: NOW },
    });
    await prisma.sosDelivery.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({ sosId: dummy.id, userId, tier: 1, kind: `SOS_HELP_INVITE_${i}`, createdAt: NOW })),
    });
  }

  it("medical: the team, owners and admins with email, and available volunteers within 3 km even when capped", async () => {
    const s = await seed();
    const near = await available(s, 2);
    const far = await available(s, 4);
    const offHours = await available(s, 1, [{ days: [(localDay + 3) % 7], from: "00:00", to: "23:59" }]);
    const capped5 = await available(s, 1);
    await capped(s, capped5);

    const sos = await sosService.create(medical(s), { userId: s.V }, NOW);
    expect((await usersOf(sos.id, "SOS_TEAM_ALERT")).sort()).toEqual([s.LEADER, s.MGR, s.V2].sort());
    const alert = (await notices(sos.id)).find((n) => n.kind === "SOS_MEDICAL_ALERT");
    expect(alert?.email).toBe(true);
    expect(alert?.userIds.sort()).toEqual([s.OWNER, ADMIN].sort());
    const invited = await usersOf(sos.id, "SOS_HELP_INVITE");
    expect(invited).toEqual(expect.arrayContaining([near, capped5]));
    expect(invited).not.toContain(far);
    expect(invited).not.toContain(offHours);
    expect((await notices(sos.id)).find((n) => n.kind === "SOS_HELP_INVITE")?.payload.medical).toBe("1");
    // Priority 2 at once (the admins already had the medical alert).
    expect(await usersOf(sos.id, "SOS_NEARBY_ORG_REQUEST")).toEqual([s.OTHER_OWNER]);
    expect(await prisma.sosDelivery.count({ where: { sosId: sos.id } })).toBeGreaterThan(0);
  });

  it("manpower: no volunteer out of hours or over 5 a day; priority 2 waits", async () => {
    const s = await seed();
    const near = await available(s, 2);
    const offHours = await available(s, 1, [{ days: [(localDay + 3) % 7], from: "00:00", to: "23:59" }]);
    const capped5 = await available(s, 1);
    await capped(s, capped5);
    const sos = await sosService.create(manpower(s), { userId: s.V }, NOW);
    expect(await usersOf(sos.id, "SOS_HELP_INVITE")).toEqual([near]);
    expect(await usersOf(sos.id, "SOS_NEARBY_ORG_REQUEST")).toEqual([]);
    expect(await usersOf(sos.id, "SOS_MEDICAL_ALERT")).toEqual([]);
    void offHours;
  });

  it("hazard: volunteers are only warned; priorities 2 and 3 at once", async () => {
    const s = await seed();
    const near = await available(s, 2);
    const sos = await sosService.create(hazard(s), { userId: s.V }, NOW);
    expect(await usersOf(sos.id, "SOS_HELP_INVITE")).toEqual([]);
    expect(await usersOf(sos.id, "SOS_HAZARD_WARNING")).toEqual(expect.arrayContaining([s.V2, near]));
    expect(await usersOf(sos.id, "SOS_NEARBY_ORG_REQUEST")).toEqual([s.OTHER_OWNER]);
    const admin = (await notices(sos.id)).find((n) => n.kind === "SOS_ADMIN_ALERT");
    expect(admin).toMatchObject({ userIds: [ADMIN], email: true });
  });
});

describe("the SOS job", () => {
  it("manpower: owners after 10 min, 5 km and priority 2 after 15 min, expiry at the shift's end", async () => {
    const s = await seed();
    const at4km = await available(s, 4);
    const sos = await sosService.create(manpower(s, { details: { peopleNeeded: 3 } }), { userId: s.V }, NOW);
    expect(sos.expiresAt?.getTime()).toBe(s.end.getTime());

    await runSosSweep(at(9 * MIN));
    expect(await usersOf(sos.id, "SOS_OWNER_ESCALATION")).toEqual([]);
    await runSosSweep(at(11 * MIN));
    expect(await usersOf(sos.id, "SOS_OWNER_ESCALATION")).toEqual([s.OWNER]);
    await runSosSweep(at(12 * MIN));
    expect(await usersOf(sos.id, "SOS_OWNER_ESCALATION")).toEqual([s.OWNER]);

    expect(await usersOf(sos.id, "SOS_HELP_INVITE")).not.toContain(at4km);
    await runSosSweep(at(16 * MIN));
    const row = await prisma.sos.findUniqueOrThrow({ where: { id: sos.id } });
    expect(row.radiusKm).toBe(5);
    expect(await usersOf(sos.id, "SOS_HELP_INVITE")).toContain(at4km);
    expect((await usersOf(sos.id, "SOS_NEARBY_ORG_REQUEST")).sort()).toEqual([s.OTHER_OWNER, ADMIN].sort());

    const responder = randomUUID();
    await sosService.respond(sos.id, { userId: responder }, at(20 * MIN));
    await runSosSweep(new Date(s.end.getTime() + MIN));
    expect((await prisma.sos.findUniqueOrThrow({ where: { id: sos.id } })).state).toBe("expired");
    expect(await usersOf(sos.id, "SOS_EXPIRED")).toEqual([responder]);
    expect(
      (await prisma.sosResponder.findFirstOrThrow({ where: { sosId: sos.id, userId: responder } })).status,
    ).toBe("cancelled");
  });

  it("manpower expires 4 h after creation when the shift lasts longer", async () => {
    const s = await seed({ endInH: 8 });
    const sos = await sosService.create(manpower(s), { userId: s.V }, NOW);
    expect(sos.expiresAt?.getTime()).toBe(at(4 * HOUR).getTime());
    await runSosSweep(at(4 * HOUR - MIN));
    expect((await prisma.sos.findUniqueOrThrow({ where: { id: sos.id } })).state).not.toBe("expired");
    await runSosSweep(at(4 * HOUR + MIN));
    expect((await prisma.sos.findUniqueOrThrow({ where: { id: sos.id } })).state).toBe("expired");
  });

  it("hazard goes to the admins after 2 h unless resolved; someone coming stops the owner escalation", async () => {
    const s = await seed();
    const left = await sosService.create(hazard(s), { userId: s.V }, NOW);
    const resolved = await sosService.create(hazard(s), { userId: s.V2 }, NOW);
    await sosService.resolve(resolved.id, { userId: s.V2 }, { code: "handled" }, at(MIN));
    const helped = await sosService.create(manpower(s), { userId: s.V2 }, NOW);
    await sosService.respond(helped.id, { userId: randomUUID() }, at(2 * MIN));

    await runSosSweep(at(11 * MIN));
    expect(await usersOf(left.id, "SOS_OWNER_ESCALATION")).toEqual([s.OWNER]);
    expect(await usersOf(resolved.id, "SOS_OWNER_ESCALATION")).toEqual([]);
    expect(await usersOf(helped.id, "SOS_OWNER_ESCALATION")).toEqual([]);

    await runSosSweep(at(2 * HOUR + MIN));
    const row = await prisma.sos.findUniqueOrThrow({ where: { id: left.id } });
    expect(row.state).toBe("escalated");
    expect(row.escalatedAt).not.toBeNull();
    expect(await usersOf(left.id, "SOS_ESCALATED")).toEqual([ADMIN]);
    expect((await prisma.sos.findUniqueOrThrow({ where: { id: resolved.id } })).state).toBe("resolved");
  });
});

describe("people coming to help", () => {
  it("helping / open, one SOS at a time, arrived within 50 m, no more invites once enough", async () => {
    const s = await seed();
    const sos = await sosService.create(manpower(s, { details: { peopleNeeded: 1 } }), { userId: s.V }, NOW);
    const other = await sosService.create(medical(s), { userId: s.V2 }, NOW);
    const R = randomUUID();

    await expect(sosService.respond(sos.id, { userId: s.V })).rejects.toMatchObject(code("SOS_RESPOND_NOT_ALLOWED"));
    let d = await sosService.respond(sos.id, { userId: R }, at(MIN));
    expect(d).toMatchObject({ state: "helping", onTheWayCount: 1, myResponse: "on_the_way" });
    d = await sosService.cancelResponse(sos.id, { userId: R }, at(2 * MIN));
    expect(d).toMatchObject({ state: "open", onTheWayCount: 0, myResponse: null });

    await sosService.respond(sos.id, { userId: R }, at(3 * MIN));
    await expect(sosService.respond(other.id, { userId: R })).rejects.toMatchObject(code("SOS_ALREADY_RESPONDING"));

    const hz = await sosService.create(hazard(s), { userId: s.LEADER }, NOW);
    await expect(sosService.respond(hz.id, { userId: randomUUID() })).rejects.toMatchObject(
      code("SOS_RESPOND_NOT_ALLOWED"),
    );

    // ~110 m away: still on the way; ~20 m: arrived.
    d = await sosService.updateResponderLocation(sos.id, { userId: R }, { latitude: sos.latitude + 0.001, longitude: sos.longitude });
    expect(d.myResponse).toBe("on_the_way");
    d = await sosService.updateResponderLocation(sos.id, { userId: R }, { latitude: sos.latitude + 0.0002, longitude: sos.longitude });
    expect(d).toMatchObject({ myResponse: "arrived", arrivedCount: 1, onTheWayCount: 0, state: "helping" });

    // Arrived, no longer "on the way": may respond to another SOS.
    await expect(sosService.respond(other.id, { userId: R })).resolves.toMatchObject({ myResponse: "on_the_way" });

    // One person needed and one there: no widening, no priority 2.
    await runSosSweep(at(16 * MIN));
    const row = await prisma.sos.findUniqueOrThrow({ where: { id: sos.id } });
    expect(row.radiusKm).toBe(3);
    expect(row.tier2SentAt).toBeNull();
    expect(await usersOf(sos.id, "SOS_OWNER_ESCALATION")).toEqual([]);
  });
});

describe("closing an SOS", () => {
  it("the reporter closes it, the people on the way hear; outsiders may not", async () => {
    const s = await seed();
    const sos = await sosService.create(manpower(s), { userId: s.V }, NOW);
    const R = randomUUID();
    await sosService.respond(sos.id, { userId: R }, at(MIN));
    await expect(
      sosService.resolve(sos.id, { userId: randomUUID() }, { code: "handled" }),
    ).rejects.toMatchObject(code("SOS_PERMISSION_DENIED"));
    const d = await sosService.resolve(sos.id, { userId: s.V }, { code: "handled", note: "Đủ người" }, at(5 * MIN));
    expect(d).toMatchObject({ state: "resolved", status: 17, resolutionCode: "handled", resolutionNote: "Đủ người", resolvedBy: s.V });
    expect(await usersOf(sos.id, "SOS_NO_LONGER_NEEDED")).toEqual([R]);
    await expect(sosService.resolve(sos.id, { userId: s.V }, { code: "handled" })).rejects.toMatchObject(code("SOS_CLOSED"));
    // The legacy alias stays idempotent.
    await expect(sosService.solveSos(sos.id, { userId: s.MGR })).resolves.toMatchObject({ state: "resolved" });
  });

  it("3 false alarms in 30 days send the reporter to the admins", async () => {
    const s = await seed();
    const ids: number[] = [];
    for (const t of [0, 61, 122]) {
      ids.push((await sosService.create(manpower(s), { userId: s.V }, at(t * MIN))).id);
    }
    await sosService.resolve(ids[0], { userId: s.MGR }, { code: "false_alarm" }, at(130 * MIN));
    await sosService.resolve(ids[1], { userId: s.LEADER }, { code: "not_real" }, at(131 * MIN));
    expect(await usersOf(ids[1], "SOS_ABUSE_REVIEW")).toEqual([]);
    await sosService.resolve(ids[2], { userId: s.MGR }, { code: "false_alarm" }, at(132 * MIN));
    const review = (await notices(ids[2])).find((n) => n.kind === "SOS_ABUSE_REVIEW");
    expect(review).toMatchObject({ userIds: [ADMIN], payload: expect.objectContaining({ reporterId: s.V, count: "3" }) });
  });
});

describe("privacy", () => {
  it("outsiders see no phone, names or medical details; responders see the contact; the team sees all", async () => {
    const s = await seed();
    const sos = await sosService.create(medical(s), { userId: s.V }, NOW);
    const R = randomUUID();
    await sosService.respond(sos.id, { userId: R }, at(MIN));

    const outsider = await sosService.getDetail(sos.id, { userId: randomUUID() });
    expect(outsider).toMatchObject({
      phone: null,
      reporter: null,
      responders: [],
      details: { consciousness: null, affected: null },
      campaign: { contactPhone: null, contactName: null, safetyNotes: "Mang găng tay" },
      onTheWayCount: 1,
      viewerIsTeam: false,
      permissions: expect.objectContaining({ canResolve: false, canRespond: true }),
    });

    const responder = await sosService.getDetail(sos.id, { userId: R });
    expect(responder).toMatchObject({
      phone: null,
      responders: [],
      details: { consciousness: "unconscious", affected: 1 },
      campaign: { contactPhone: "0911000111" },
      permissions: expect.objectContaining({ canCancelResponse: true, canRespond: false }),
    });

    const team = await sosService.getDetail(sos.id, { userId: s.MGR });
    expect(team).toMatchObject({ phone: "0901234567", viewerIsTeam: true, reporter: expect.objectContaining({ id: s.V }) });
    expect(team.responders).toEqual([expect.objectContaining({ userId: R, status: "on_the_way", name: expect.any(String) })]);
    const creator = await sosService.getDetail(sos.id, { userId: s.V });
    expect(creator.responders).toHaveLength(1);
    expect(creator.phone).toBeNull();
    const admin = await sosService.getDetail(sos.id, { userId: randomUUID(), role: "admin" });
    expect(admin.phone).toBe("0901234567");

    const list = await sosService.list(
      { campaignId: s.campaign.id, states: ["open", "helping", "escalated"], page: 1, limit: 20 },
      { userId: randomUUID() },
    );
    expect(list.items[0]).toMatchObject({ phone: null, reporter: null });
    expect(list.items[0]).not.toHaveProperty("details");
  });

  it("lists medical first", async () => {
    const s = await seed();
    const m = await sosService.create(manpower(s), { userId: s.V }, NOW);
    const med = await sosService.create(medical(s), { userId: s.V }, at(-MIN));
    const list = await sosService.list(
      { campaignId: s.campaign.id, states: ["open", "helping", "escalated"], page: 1, limit: 20 },
      null,
    );
    expect(list.items.map((i) => i.id)).toEqual([med.id, m.id]);
    expect(list.total).toBe(2);
  });
});

/** Runs `GET /sos` through the controller (validation + query parsing) as `actor`. */
async function listViaController(query: Record<string, string>, actor: { userId: string; role?: string }) {
  const chain = sosController.listSos;
  const req = { query, body: {}, params: {}, user: actor } as never;
  for (const v of chain.slice(0, -1)) await (v as ValidationChain).run(req);
  let status = 0;
  let body: { data?: { items: Array<{ id: number; state: string }>; total: number } } = {};
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: typeof body) {
      body = payload;
      return this;
    },
  };
  await (chain[chain.length - 1] as (req: never, res: never) => Promise<void>)(req, res as never);
  return { status, data: body.data };
}

describe("the SOS list", () => {
  const ALL = ["open", "helping", "escalated", "resolved", "expired"] as never[];

  it("filters by type, by states (all), and by search on the title or the id", async () => {
    const s = await seed();
    const title = `Nhặt rác ${randomUUID().slice(0, 8)}`;
    await prisma.campaign.update({ where: { id: s.campaign.id }, data: { title } });
    const m = await sosService.create(manpower(s), { userId: s.V }, NOW);
    const hz = await sosService.create(hazard(s), { userId: s.V }, at(MIN));
    const closed = await sosService.create(manpower(s), { userId: s.V2 }, at(2 * MIN));
    await sosService.resolve(closed.id, { userId: s.MGR }, { code: "false_alarm" }, at(3 * MIN));
    const base = { campaignId: s.campaign.id, page: 1, limit: 20 };
    const viewer = { userId: randomUUID() };

    const hazards = await sosService.list({ ...base, states: ["open", "helping", "escalated"], type: "hazard" }, viewer);
    expect(hazards.items.map((i) => i.id)).toEqual([hz.id]);

    const live = await sosService.list({ ...base, states: ["open", "helping", "escalated"] }, viewer);
    expect(live.items.map((i) => i.id).sort()).toEqual([m.id, hz.id].sort());
    const every = await sosService.list({ ...base, states: ALL }, viewer);
    expect(every.total).toBe(3);
    // Public fields on every row.
    expect(every.items.find((i) => i.id === closed.id)).toMatchObject({
      campaignTitle: title,
      reporterRole: "volunteer",
      state: "resolved",
      resolutionCode: "false_alarm",
      resolvedAt: at(3 * MIN),
    });

    // Title, case-insensitive, without the campaign filter; LIKE wildcards are literal.
    const byTitle = await sosService.list({ states: ALL, page: 1, limit: 20, search: title.toUpperCase() }, viewer);
    expect(byTitle.items.map((i) => i.id).sort()).toEqual([m.id, hz.id, closed.id].sort());
    const wildcard = await sosService.list({ ...base, states: ALL, search: "%" }, viewer);
    expect(wildcard.total).toBe(0);
    const byId = await sosService.list({ ...base, states: ALL, search: String(hz.id) }, viewer);
    expect(byId.items.map((i) => i.id)).toEqual([hz.id]);

    // Through the controller: `states=all`, `type`, `search`; an unknown type is refused.
    const viaAll = await listViaController({ campaign_id: s.campaign.id, states: "all" }, viewer);
    expect(viaAll.status).toBe(200);
    expect(viaAll.data?.total).toBe(3);
    const viaDefault = await listViaController({ campaign_id: s.campaign.id }, viewer);
    expect(viaDefault.data?.items.map((i) => i.id).sort()).toEqual([m.id, hz.id].sort());
    const viaType = await listViaController(
      { campaign_id: s.campaign.id, states: "all", type: "manpower", search: title.slice(3) },
      viewer,
    );
    expect(viaType.data?.items.map((i) => i.id).sort()).toEqual([m.id, closed.id].sort());
    expect((await listViaController({ type: "fire" }, viewer)).status).toBe(400);
  });

  it("escalated first, then medical, then newest", async () => {
    const s = await seed();
    const old = await sosService.create(hazard(s), { userId: s.V }, at(-10 * MIN));
    const m = await sosService.create(manpower(s), { userId: s.V }, NOW);
    const med = await sosService.create(medical(s), { userId: s.V2 }, at(-5 * MIN));
    await prisma.sos.update({ where: { id: old.id }, data: { state: "escalated", escalatedAt: NOW } });
    const list = await sosService.list(
      { campaignId: s.campaign.id, states: ["open", "helping", "escalated"], page: 1, limit: 20 },
      null,
    );
    expect(list.items.map((i) => i.id)).toEqual([old.id, med.id, m.id]);
  });

  it("the reporter and the phone only for the team and admins", async () => {
    const s = await seed();
    const a = await sosService.create(manpower(s), { userId: s.V }, NOW);
    const b = await sosService.create(medical(s), { userId: s.V2 }, NOW);
    const query = { campaignId: s.campaign.id, states: ["open", "helping", "escalated"] as never[], page: 1, limit: 20 };
    const reporterOf = (id: string) => ({ id, name: expect.any(String), avatar: null });

    for (const viewer of [{ userId: randomUUID() }, null, { userId: s.OTHER_OWNER }]) {
      const list = await sosService.list(query, viewer);
      expect(list.items).toHaveLength(2);
      for (const item of list.items) expect(item).toMatchObject({ reporter: null, phone: null });
    }
    // The reporter sees their own row's public fields, not their own phone.
    expect((await sosService.list(query, { userId: s.V })).items.every((i) => i.phone === null)).toBe(true);

    for (const viewer of [{ userId: s.MGR }, { userId: s.OWNER }, { userId: s.LEADER }, { userId: randomUUID(), role: "admin" }]) {
      const list = await sosService.list(query, viewer);
      const byId = new Map(list.items.map((i) => [i.id, i]));
      expect(byId.get(a.id)).toMatchObject({ phone: "0901234567", reporter: reporterOf(s.V) });
      expect(byId.get(b.id)).toMatchObject({ phone: "0901234567", reporter: reporterOf(s.V2) });
    }

    // The team of another campaign is an outsider here.
    const t = await seed();
    const list = await sosService.list(
      { states: ["open", "helping", "escalated"] as never[], page: 1, limit: 100, search: String(a.id) },
      { userId: t.MGR },
    );
    expect(list.items.find((i) => i.id === a.id)).toMatchObject({ reporter: null, phone: null });
  });
});

describe("campaign completion", () => {
  it("resolves the live SOS as handled", async () => {
    const s = await seed();
    const sos = await sosService.create(manpower(s), { userId: s.V }, NOW);
    const R = randomUUID();
    await sosService.respond(sos.id, { userId: R }, at(MIN));
    await prisma.campaign.update({ where: { id: s.campaign.id }, data: { status: CampaignStatus.PENDING_COMPLETION } });
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: s.campaign.id }, include: CAMPAIGN_INCLUDE });
    await prisma.$transaction((tx) =>
      completeCampaign(tx, campaign, {
        actor: "admin",
        actorId: ADMIN,
        payout: { difficulty: 1, credits: [], volunteerIds: [] },
      }),
    );
    const row = await prisma.sos.findUniqueOrThrow({ where: { id: sos.id } });
    expect(row).toMatchObject({ state: "resolved", status: 17, resolutionCode: "handled", resolvedBy: ADMIN });
    expect((await prisma.sosResponder.findFirstOrThrow({ where: { sosId: sos.id } })).status).toBe("cancelled");
  });
});
