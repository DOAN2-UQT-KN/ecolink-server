/**
 * Phase 4 — campaign permissions by organization role, against a real Postgres.
 * (Status rules — what may be edited or deleted when — are in campaign-lifecycle.it.test.ts.)
 *
 *   - who may create a campaign (CAMPAIGN_CREATE: LR / OWNER / CAMPAIGN_MANAGER)
 *   - owners manage campaigns they did not create; org admins do not
 *   - managers must be members; the creator cannot be removed
 *   - leaving the organization ends campaign-manager rights
 *   - resolving an SOS and reading the approved-volunteer list are restricted
 *   - "my campaigns" (is_owner) lists every campaign of an organization one owns
 *
 * identity, reward and notification clients are mocked; the DB is real.
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./setup/test-db";

jest.mock("../modules/organization/identity-user.client", () => ({
  fetchOrganizationOwnersByUserIds: async () => new Map(),
  getUserProfile: () => undefined,
}));
jest.mock("../modules/reward/reward-service.client", () => ({
  rewardServiceClient: {
    getDifficultyByLevel: async () => ({ level: 1, maxVolunteers: 10, greenPoints: 10 }),
    getDifficultyByLevelStrict: async () => ({ level: 1, maxVolunteers: 10, greenPoints: 10 }),
    getDifficulties: async () => [],
  },
}));
jest.mock("../queue/register", () => ({
  backgroundJobDispatcher: {
    dispatch: jest.fn().mockResolvedValue(undefined),
    enqueue: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock("../modules/campaign/notification-jobs.client", () => ({
  enqueueWebsiteNotificationsToUsers: jest.fn().mockResolvedValue(undefined),
  enqueueWebsiteNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../modules/organization/organization-member-notify.client", () => ({
  enqueueOrgMembershipChangedWebsiteNotification: jest.fn().mockResolvedValue(undefined),
  enqueueOrgInvitationPendingWebsiteNotification: jest.fn().mockResolvedValue(undefined),
  enqueueOrgInvitationRejectedWebsiteNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../modules/organization_application/owner-change-notify.client", () => ({
  notifyApprovalRequested: jest.fn(),
  notifyRemovalProposed: jest.fn(),
  notifyDecided: jest.fn(),
  notifyOwnerLeft: jest.fn(),
}));

import { campaignService } from "../modules/campaign/campaign.service";
import { campaignManagerService } from "../modules/campaign/campaign_manager/campaign_manager.service";
import { campaignRegistrationService } from "../modules/campaign/campaign_registration/campaign_registration.service";
import { organizationService } from "../modules/organization/organization.service";
import { sosService } from "../modules/sos/sos.service";
import { GlobalStatus } from "../constants/status.enum";

const LR = randomUUID();
const OWNER = randomUUID();
const ORG_ADMIN = randomUUID();
const CM = randomUUID();
const MEMBER = randomUUID();
const OUTSIDER = randomUUID();

let orgId: string;

async function resetTables(): Promise<void> {
  await prisma.$executeRaw(
    Prisma.sql`TRUNCATE TABLE "outbox_events", "organization_applications", "organizations" RESTART IDENTITY CASCADE`,
  );
}

async function seedOrganization() {
  const org = await prisma.organization.create({
    data: {
      name: `Org ${randomUUID()}`,
      slug: `org-${randomUUID()}`,
      logoUrl: "https://example.com/logo.png",
      status: 1,
      members: {
        create: [
          { userId: LR, role: "LEGAL_REPRESENTATIVE", source: "INTERNAL" },
          { userId: OWNER, role: "OWNER", source: "INTERNAL" },
          { userId: ORG_ADMIN, role: "ADMIN", source: "INTERNAL" },
          { userId: CM, role: "CAMPAIGN_MANAGER", source: "INTERNAL" },
          { userId: MEMBER, role: "MEMBER", source: "INTERNAL" },
        ],
      },
    },
  });
  return org.id;
}

/** A campaign created by `creator`, who is also its first manager (as the service does). */
async function seedCampaign(creator: string, status: number = GlobalStatus._STATUS_ACTIVE) {
  return prisma.campaign.create({
    data: {
      title: `Campaign ${randomUUID().slice(0, 8)}`,
      status,
      organizationId: orgId,
      createdBy: creator,
      latitude: 10.77,
      longitude: 106.7,
      campaignManagers: { create: { userId: creator, assignedBy: creator } },
    },
  });
}

const code = (c: string) => ({ statusResponse: expect.objectContaining({ code: c }) });

beforeEach(async () => {
  await resetTables();
  orgId = await seedOrganization();
});

afterAll(async () => {
  await resetTables();
});

describe("creating a campaign needs CAMPAIGN_CREATE", () => {
  const request = () => ({ organizationId: orgId, title: "Clean the beach", difficulty: 1 });

  it("a campaign manager of the organization may create one", async () => {
    const created = await campaignService.createCampaign(CM, request() as never);
    expect(created.id).toBeDefined();
    expect(
      await prisma.campaignManager.count({ where: { campaignId: created.id, userId: CM } }),
    ).toBe(1);
  });

  it.each([
    ["an org admin", ORG_ADMIN],
    ["a plain member", MEMBER],
    ["an outsider", OUTSIDER],
  ])("%s may not", async (_label, userId) => {
    await expect(
      campaignService.createCampaign(userId, request() as never),
    ).rejects.toMatchObject(code("ORG_PERMISSION_DENIED"));
    expect(await prisma.campaign.count()).toBe(0);
  });
});

describe("managing a campaign", () => {
  it("an owner may edit a campaign someone else created; an org admin may not", async () => {
    // Under review: every field is still editable (the title locks once approved).
    const campaign = await seedCampaign(CM, GlobalStatus._STATUS_PENDING);
    await campaignService.updateCampaign(campaign.id, OWNER, { title: "Renamed" } as never);
    expect((await prisma.campaign.findUnique({ where: { id: campaign.id } }))?.title).toBe(
      "Renamed",
    );
    await expect(
      campaignService.updateCampaign(campaign.id, ORG_ADMIN, { title: "No" } as never),
    ).rejects.toMatchObject(code("CAMPAIGN_PERMISSION_DENIED"));
  });

  it("a manager may not delete; the legal representative may", async () => {
    // Only campaigns not yet approved (or blocked/expired) can be deleted.
    const campaign = await seedCampaign(CM, GlobalStatus._STATUS_PENDING);
    await campaignManagerService.addManagers(campaign.id, { userIds: [MEMBER] }, CM);
    await expect(campaignService.deleteCampaign(campaign.id, MEMBER)).rejects.toMatchObject(
      code("CAMPAIGN_PERMISSION_DENIED"),
    );
    await campaignService.deleteCampaign(campaign.id, LR);
    expect((await prisma.campaign.findUnique({ where: { id: campaign.id } }))?.deletedAt).not.toBeNull();
  });

  it("managers must be members of the organization, and the creator stays", async () => {
    const campaign = await seedCampaign(CM);
    await expect(
      campaignManagerService.addManagers(campaign.id, { userIds: [OUTSIDER] }, CM),
    ).rejects.toMatchObject(code("CAMPAIGN_MANAGER_NOT_MEMBER"));
    await expect(
      campaignManagerService.removeManager(campaign.id, CM, OWNER),
    ).rejects.toMatchObject(code("CANNOT_REMOVE_CAMPAIGN_CREATOR"));
  });

  it("a removed manager can be added back", async () => {
    const campaign = await seedCampaign(CM);
    await campaignManagerService.addManagers(campaign.id, { userIds: [MEMBER] }, CM);
    await campaignManagerService.removeManager(campaign.id, MEMBER, CM);
    await campaignManagerService.addManagers(campaign.id, { userIds: [MEMBER] }, CM);
    expect(await campaignManagerService.canManageCampaign(campaign.id, MEMBER)).toBe(true);
  });

  it("leaving the organization ends campaign-manager rights", async () => {
    const campaign = await seedCampaign(CM);
    await campaignManagerService.addManagers(campaign.id, { userIds: [MEMBER] }, CM);
    await organizationService.removeMember(orgId, OWNER, MEMBER);
    expect(
      await prisma.campaignManager.count({
        where: { campaignId: campaign.id, userId: MEMBER, deletedAt: null },
      }),
    ).toBe(0);
    expect(await campaignManagerService.canManageCampaign(campaign.id, MEMBER)).toBe(false);

    // The creator leaving loses their rights too.
    await organizationService.leaveOrganization(orgId, CM);
    expect(await campaignManagerService.canManageCampaign(campaign.id, CM)).toBe(false);
  });
});

describe("SOS and volunteers", () => {
  async function seedSos(campaignId: string) {
    return prisma.sos.create({
      data: {
        campaignId,
        content: "Help",
        phone: "0900000000",
        address: "Somewhere",
        latitude: 10.77,
        longitude: 106.7,
        // Someone else: the reporter may close their own SOS.
        createdBy: randomUUID(),
      },
    });
  }

  it("only the reporter, the campaign's managers or a platform admin resolve an SOS", async () => {
    const campaign = await seedCampaign(CM);
    const sos = await seedSos(campaign.id);
    await expect(sosService.solveSos(sos.id, { userId: OUTSIDER })).rejects.toMatchObject(
      code("SOS_PERMISSION_DENIED"),
    );
    await expect(sosService.solveSos(sos.id, { userId: ORG_ADMIN })).rejects.toMatchObject(
      code("SOS_PERMISSION_DENIED"),
    );
    const solved = await sosService.solveSos(sos.id, { userId: CM });
    expect(solved.status).toBe(GlobalStatus._STATUS_COMPLETED);
    expect(solved.state).toBe("resolved");

    const other = await seedSos(campaign.id);
    await sosService.solveSos(other.id, { userId: randomUUID(), role: "admin" });
    expect((await prisma.sos.findUnique({ where: { id: other.id } }))?.status).toBe(
      GlobalStatus._STATUS_COMPLETED,
    );
  });

  it("the volunteer list is for managers, registered volunteers and admins", async () => {
    const campaign = await seedCampaign(CM);
    const VOLUNTEER = randomUUID();
    const start = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    const end = new Date(start.getTime() + 4 * 3600 * 1000);
    const day = await prisma.campaignDay.create({
      data: { campaignId: campaign.id, startAt: start, endAt: end },
    });
    const point = await prisma.campaignMeetingPoint.create({
      data: { campaignId: campaign.id, latitude: 10.77, longitude: 106.7, radiusKm: 1 },
    });
    const shift = await prisma.campaignShift.create({
      data: {
        campaignId: campaign.id,
        dayId: day.id,
        meetingPointId: point.id,
        startAt: start,
        endAt: end,
        minVolunteers: 5,
      },
    });
    await prisma.campaignShiftRegistration.create({
      data: { campaignId: campaign.id, shiftId: shift.id, userId: VOLUNTEER },
    });
    const list = (userId: string, role?: string) =>
      campaignRegistrationService.listVolunteers(campaign.id, { userId, role }, {});

    await expect(list(OUTSIDER)).rejects.toMatchObject(code("CAMPAIGN_PERMISSION_DENIED"));
    await expect(list(MEMBER)).rejects.toMatchObject(code("CAMPAIGN_PERMISSION_DENIED"));
    expect((await list(VOLUNTEER)).total).toBe(1);
    expect((await list(OWNER)).total).toBe(1);
    expect((await list(randomUUID(), "admin")).total).toBe(1);
  });
});

it("an owner's 'my campaigns' lists every campaign of the organization", async () => {
  const campaign = await seedCampaign(CM);
  const mine = await campaignService.getMyCampaigns(
    { page: 1, limit: 10, isOwner: true } as never,
    OWNER,
  );
  expect(mine.campaigns.map((c: { id: string }) => c.id)).toContain(campaign.id);
  const forAdmin = await campaignService.getMyCampaigns(
    { page: 1, limit: 10, isOwner: true } as never,
    ORG_ADMIN,
  );
  expect(forAdmin.campaigns).toHaveLength(0);
});
