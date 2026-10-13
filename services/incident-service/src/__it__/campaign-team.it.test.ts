/**
 * Campaign team (Đặc tả luồng chiến dịch 3.4), against a real Postgres.
 *
 *   - the team is the creator, the managers and the organization's owners, all still members
 *   - only the team may lead a shift; a manager leading shifts to come cannot be removed
 *   - leaving the organization takes someone off the team: their shifts lose their leader and
 *     the campaigns they created pass to the longest-standing owner, logged and announced
 *   - an owner stepping down keeps only the shifts of campaigns where they are still on the team
 *
 * identity and notification clients are mocked; the DB is real.
 */

jest.mock("../modules/organization/identity-user.client", () => ({
  fetchOrganizationOwnersByUserIds: async () => new Map(),
  getUserProfile: () => undefined,
}));
jest.mock("../modules/organization_application/owner-change-notify.client", () => ({
  notifyApprovalRequested: jest.fn(),
  notifyRemovalProposed: jest.fn(),
  notifyDecided: jest.fn(),
  notifyOwnerLeft: jest.fn(),
}));
jest.mock("../modules/organization/organization-member-notify.client", () => ({
  enqueueOrgMembershipChangedWebsiteNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../queue/register", () => ({
  backgroundJobDispatcher: {
    dispatch: jest.fn().mockResolvedValue(undefined),
    enqueue: jest.fn().mockResolvedValue(undefined),
  },
}));

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { CampaignStatus } from "@da2/constants";
import { prisma } from "./setup/test-db";
import { findTeamIds } from "../modules/campaign/campaign_manager/campaign-team";
import { campaignManagerService } from "../modules/campaign/campaign_manager/campaign_manager.service";
import { organizationService } from "../modules/organization/organization.service";

const HOUR = 60 * 60 * 1000;
const OLD_OWNER = randomUUID();
const OWNER = randomUUID();
const CREATOR = randomUUID();
const CM = randomUUID();
const MEMBER = randomUUID();

let orgId: string;

const code = (c: string) => ({ statusResponse: expect.objectContaining({ code: c }) });

/** One upcoming day with one shift led by `leader`; CREATOR created it and CM manages it. */
async function seedCampaign(leader: string, opts: { startInHours?: number } = {}) {
  const start = new Date(Date.now() + (opts.startInHours ?? 72) * HOUR);
  const end = new Date(start.getTime() + 4 * HOUR);
  const campaign = await prisma.campaign.create({
    data: {
      title: `Campaign ${randomUUID().slice(0, 8)}`,
      status: CampaignStatus.UPCOMING,
      organizationId: orgId,
      createdBy: CREATOR,
      latitude: 10.77,
      longitude: 106.7,
      campaignManagers: {
        create: [
          { userId: CREATOR, assignedBy: CREATOR },
          { userId: CM, assignedBy: CREATOR },
        ],
      },
    },
  });
  const day = await prisma.campaignDay.create({
    data: { campaignId: campaign.id, startAt: start, endAt: end },
  });
  const point = await prisma.campaignMeetingPoint.create({
    data: { campaignId: campaign.id, latitude: 10.77, longitude: 106.7, radiusKm: 1, sortOrder: 0 },
  });
  const shift = await prisma.campaignShift.create({
    data: {
      campaignId: campaign.id,
      dayId: day.id,
      meetingPointId: point.id,
      startAt: start,
      endAt: end,
      minVolunteers: 2,
      leaderUserId: leader,
    },
  });
  return { id: campaign.id, shiftId: shift.id };
}

const leaderOf = async (shiftId: string) =>
  (await prisma.campaignShift.findUniqueOrThrow({ where: { id: shiftId } })).leaderUserId;

const outboxKinds = async () =>
  (await prisma.outboxEvent.findMany({ orderBy: { createdAt: "asc" } })).map((e) => {
    const p = e.payload as { kind: string; userIds: string[]; payload: Record<string, string> };
    return { kind: p.kind, userIds: [...p.userIds].sort(), forYou: p.payload.forYou };
  });

beforeEach(async () => {
  await prisma.$executeRaw(
    Prisma.sql`TRUNCATE TABLE "outbox_events", "organizations", "campaigns" RESTART IDENTITY CASCADE`,
  );
  const joined = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR);
  const org = await prisma.organization.create({
    data: {
      name: `Org ${randomUUID()}`,
      slug: `org-${randomUUID()}`,
      logoUrl: "https://example.com/logo.png",
      status: 1,
      members: {
        create: [
          { userId: OLD_OWNER, role: "OWNER", source: "INTERNAL", createdAt: joined(100) },
          { userId: OWNER, role: "OWNER", source: "INTERNAL", createdAt: joined(50) },
          { userId: CREATOR, role: "CAMPAIGN_MANAGER", source: "INTERNAL", createdAt: joined(40) },
          { userId: CM, role: "CAMPAIGN_MANAGER", source: "INTERNAL", createdAt: joined(30) },
          { userId: MEMBER, role: "MEMBER", source: "INTERNAL", createdAt: joined(20) },
        ],
      },
    },
  });
  orgId = org.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the team", () => {
  it("is the creator, the managers and the owners; a plain member or an outsider is not", async () => {
    const c = await seedCampaign(CREATOR);
    const team = await findTeamIds(
      prisma,
      { id: c.id, organizationId: orgId, createdBy: CREATOR },
      [CREATOR, CM, OWNER, MEMBER, randomUUID()],
    );
    expect([...team].sort()).toEqual([CREATOR, CM, OWNER].sort());
  });
});

describe("shift leader", () => {
  it("must be on the team; a change is logged", async () => {
    const c = await seedCampaign(CREATOR);
    await expect(
      campaignManagerService.setShiftLeader(c.id, c.shiftId, MEMBER, CREATOR),
    ).rejects.toMatchObject(code("CAMPAIGN_LEADER_NOT_MANAGER"));

    await campaignManagerService.setShiftLeader(c.id, c.shiftId, OWNER, CREATOR);
    expect(await leaderOf(c.shiftId)).toBe(OWNER);
    const log = await prisma.campaignStatusLog.findFirstOrThrow({
      where: { campaignId: c.id, event: "set_shift_leader" },
    });
    expect(log.changes).toMatchObject({ leaderUserId: { from: CREATOR, to: OWNER } });
  });

  it("cannot be changed once the shift has ended", async () => {
    const c = await seedCampaign(CREATOR, { startInHours: -6 });
    await expect(
      campaignManagerService.setShiftLeader(c.id, c.shiftId, CM, CREATOR),
    ).rejects.toMatchObject(code("SHIFT_ALREADY_STARTED"));
  });
});

describe("removing a manager", () => {
  it("is refused while they lead a shift to come, and allowed once someone else leads it", async () => {
    const c = await seedCampaign(CM);
    await expect(campaignManagerService.removeManager(c.id, CM, CREATOR)).rejects.toMatchObject(
      code("CAMPAIGN_MANAGER_LEADS_SHIFTS"),
    );

    await campaignManagerService.setShiftLeader(c.id, c.shiftId, CREATOR, CREATOR);
    await campaignManagerService.removeManager(c.id, CM, CREATOR);
    const row = await prisma.campaignManager.findUniqueOrThrow({
      where: { campaignId_userId: { campaignId: c.id, userId: CM } },
    });
    expect(row.deletedAt).not.toBeNull();
  });

  it("is not refused for an owner: they stay on the team without the manager row", async () => {
    const c = await seedCampaign(OWNER);
    await prisma.campaignManager.create({
      data: { campaignId: c.id, userId: OWNER, assignedBy: CREATOR },
    });
    await campaignManagerService.removeManager(c.id, OWNER, CREATOR);
    expect(await leaderOf(c.shiftId)).toBe(OWNER);
  });
});

describe("leaving the organization", () => {
  it("a manager who leaves stops managing and their shifts lose their leader; the team hears", async () => {
    const c = await seedCampaign(CM);
    await organizationService.leaveOrganization(orgId, CM);

    expect(await leaderOf(c.shiftId)).toBeNull();
    const row = await prisma.campaignManager.findUniqueOrThrow({
      where: { campaignId_userId: { campaignId: c.id, userId: CM } },
    });
    expect(row.deletedAt).not.toBeNull();
    expect(
      await prisma.campaignStatusLog.count({ where: { campaignId: c.id, event: "clear_shift_leader" } }),
    ).toBe(1);
    expect(await outboxKinds()).toEqual([
      { kind: "CAMPAIGN_SHIFT_LEADER_REMOVED", userIds: [CREATOR], forYou: undefined },
    ]);
  });

  it("the creator leaving hands the campaign to the longest-standing owner", async () => {
    const c = await seedCampaign(CM);
    await organizationService.removeMember(orgId, OWNER, CREATOR);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(campaign.createdBy).toBe(OLD_OWNER);
    const heirRow = await prisma.campaignManager.findUniqueOrThrow({
      where: { campaignId_userId: { campaignId: c.id, userId: OLD_OWNER } },
    });
    expect(heirRow.deletedAt).toBeNull();
    const log = await prisma.campaignStatusLog.findFirstOrThrow({
      where: { campaignId: c.id, event: "transfer_creator" },
    });
    expect(log.changes).toMatchObject({ createdBy: { from: CREATOR, to: OLD_OWNER } });
    // CM still leads the shift: only the creator left.
    expect(await leaderOf(c.shiftId)).toBe(CM);
    expect(await outboxKinds()).toEqual([
      { kind: "CAMPAIGN_CREATOR_TRANSFERRED", userIds: [OLD_OWNER], forYou: "1" },
      { kind: "CAMPAIGN_CREATOR_TRANSFERRED", userIds: [CM], forYou: undefined },
    ]);
  });
});

describe("an owner stepping down", () => {
  it("loses the shifts they led only as an owner, keeps those of campaigns they manage", async () => {
    const asOwner = await seedCampaign(OWNER);
    const asManager = await seedCampaign(OWNER);
    await prisma.campaignManager.create({
      data: { campaignId: asManager.id, userId: OWNER, assignedBy: CREATOR },
    });

    await organizationService.stepDown(orgId, OWNER, "MEMBER");

    expect(await leaderOf(asOwner.shiftId)).toBeNull();
    expect(await leaderOf(asManager.shiftId)).toBe(OWNER);
  });
});
