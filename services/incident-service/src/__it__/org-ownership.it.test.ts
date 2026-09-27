/**
 * Multi-owner organizations against a real Postgres.
 *
 * The four cases the design calls "silent failures" — they run without an error and leave
 * the data wrong — so they are proven here rather than with mocks:
 *   (a) two concurrent approvals for someone at 2 organizations → exactly one wins
 *   (b) an owner who already has an account is attached, not re-created
 *   (c) an organization cannot be committed without an owner membership
 *   (d) the last owner membership cannot be removed
 * Phase 2 adds:
 *   (f) two concurrent accepts of one invitation create exactly one membership
 * Phase 3 (owner changes, decided inside the organization) adds:
 *   (e) an applied ADD_OWNER upgrades a MEMBER to OWNER in place
 *   (g) an ADD_OWNER failing after the first person was granted rolls back entirely
 *   (h) two owners leaving at the same moment: exactly one succeeds
 *   (i) two owners of a 2-owner org removing each other at once: exactly one applies
 *   (j) the last owner cannot leave or step down, and nothing is written
 *
 * identity-service and notification-service are mocked; everything in incident's own DB
 * (row locks, the advisory lock, the deferred owner trigger) is real.
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./setup/test-db";

const ensureUsersMock = jest.fn();
const lookupUsersMock = jest.fn();
const issueActivationTokenMock = jest.fn();
const attachedEmailMock = jest.fn();
const activationEmailMock = jest.fn();
const lookupUsersByIdsMock = jest.fn();

jest.mock("../modules/organization_application/identity-owner.client", () => ({
  IdentityUserStatus: { ACTIVE: 1, INACTIVE: 2, PENDING_ACTIVATION: 3 },
  ensureUsers: (...a: unknown[]) => ensureUsersMock(...a),
  lookupUsersByEmails: (...a: unknown[]) => lookupUsersMock(...a),
  issueActivationToken: (...a: unknown[]) => issueActivationTokenMock(...a),
  lookupUsersByIds: (...a: unknown[]) => lookupUsersByIdsMock(...a),
}));

jest.mock("../modules/organization_application/owner-change-notify.client", () => ({
  notifyApprovalRequested: jest.fn(),
  notifyRemovalProposed: jest.fn(),
  notifyDecided: jest.fn(),
  notifyOwnerLeft: jest.fn(),
}));

jest.mock("../modules/organization/organization-member-notify.client", () => ({
  enqueueOrgMembershipChangedWebsiteNotification: jest.fn().mockResolvedValue(undefined),
  enqueueOrgInvitationPendingWebsiteNotification: jest.fn().mockResolvedValue(undefined),
  enqueueOrgInvitationRejectedWebsiteNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../modules/organization/identity-user.client", () => ({
  fetchOrganizationOwnersByUserIds: async () => new Map(),
  getUserProfile: () => undefined,
}));

jest.mock("../modules/organization_application/organization-application-notify.client", () => ({
  enqueueApplicationRejectedEmail: jest.fn(),
  enqueueApplicationNeedsInfoEmail: jest.fn(),
  enqueueOwnerAttachedEmail: (...a: unknown[]) => attachedEmailMock(...a),
  enqueueAccountActivationEmail: (...a: unknown[]) => activationEmailMock(...a),
  enqueueApplicationWithdrawnNoticeEmail: jest.fn().mockResolvedValue(undefined),
  enqueueOwnerConfirmationRequestEmail: jest.fn().mockResolvedValue(undefined),
  enqueueEmailToUser: jest.fn().mockResolvedValue(undefined),
}));

import { organizationApplicationAdminService } from "../modules/organization_application/organization-application-admin.service";
import { organizationOwnerOnboardPublisher } from "../modules/organization_application/organization-owner-onboard.publisher";
import { organizationInvitationService } from "../modules/organization/organization-invitation.service";
import { organizationService } from "../modules/organization/organization.service";
import { ownerChangeExecutor } from "../modules/organization_application/owner-change-executor";
import { ownerChangeService } from "../modules/organization_application/owner-change.service";
import { hashOpaqueToken } from "../utils/token-hash";

const ADMIN = randomUUID();

async function resetTables(): Promise<void> {
  await prisma.$executeRaw(
    Prisma.sql`TRUNCATE TABLE "outbox_events", "owner_invite_blocks", "organization_applications", "organizations" RESTART IDENTITY CASCADE`,
  );
}

/** An active organization with one owner, created the only way the DB allows. */
async function seedOrganization(ownerUserId: string, name = `Org ${randomUUID()}`) {
  return prisma.organization.create({
    data: {
      name,
      slug: `org-${randomUUID()}`,
      logoUrl: "https://example.com/logo.png",
      status: 1,
      members: {
        create: { userId: ownerUserId, role: "OWNER", source: "INTERNAL" },
      },
    },
  });
}

/** An application every owner has confirmed, sitting in the admin queue. */
async function seedPendingReview(
  owners: { email: string; fullName: string; isLegalRep: boolean }[],
  name = `CLB ${randomUUID().slice(0, 8)}`,
) {
  return prisma.organizationApplication.create({
    data: {
      code: `ORG-${randomUUID().slice(0, 8).toUpperCase()}`,
      type: "NEW_ORG",
      orgType: "SCHOOL",
      status: "PENDING_REVIEW",
      submitterEmail: owners[0].email,
      contactEmail: owners[0].email,
      emailVerifiedAt: new Date(),
      consentedAt: new Date(),
      submittedAt: new Date(),
      profile: { name, logoUrl: "https://example.com/logo.png" },
      channels: [{ type: "WEBSITE", url: "https://example.edu.vn" }],
      owners: {
        create: owners.map((o) => ({
          ...o,
          status: "CONFIRMED",
          respondedAt: new Date(),
          confirmIp: "14.161.0.1",
        })),
      },
    },
  });
}

const approve = (applicationId: string) =>
  organizationApplicationAdminService.decide(applicationId, ADMIN, {
    decision: "APPROVE",
    lane: "A",
    documentsWaived: true,
    documentsWaivedReason: "Official school domain",
  });

function identityUser(id: string, email: string, status = 1) {
  return { id, email, name: email, status, createdAt: new Date() };
}

describe("[it] organization ownership", () => {
  beforeEach(async () => {
    await resetTables();
    jest.clearAllMocks();
    lookupUsersMock.mockResolvedValue(new Map());
    lookupUsersByIdsMock.mockImplementation(async (ids: string[]) =>
      new Map(ids.map((id) => [id, identityUser(id, `${id.slice(0, 8)}@clb.vn`)])),
    );
    attachedEmailMock.mockResolvedValue(undefined);
    activationEmailMock.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("(a) two concurrent approvals for a user who owns 2 organizations: one wins, one OWNER_QUOTA_EXCEEDED", async () => {
    const userId = randomUUID();
    const email = "busy@example.com";
    await seedOrganization(userId);
    await seedOrganization(userId);
    ensureUsersMock.mockResolvedValue(new Map([[email, identityUser(userId, email)]]));

    const first = await seedPendingReview([{ email, fullName: "Busy", isLegalRep: true }]);
    const second = await seedPendingReview([{ email, fullName: "Busy", isLegalRep: true }]);

    const results = await Promise.allSettled([approve(first.id), approve(second.id)]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({
      statusResponse: { code: "OWNER_QUOTA_EXCEEDED" },
    });

    const ownerships = await prisma.organizationMember.count({
      where: { userId, deletedAt: null, role: { in: ["OWNER", "LEGAL_REPRESENTATIVE"] } },
    });
    expect(ownerships).toBe(3);
    // The loser rolled back completely: no half-created organization, still in the queue.
    expect(await prisma.organization.count()).toBe(3);
    const statuses = (
      await prisma.organizationApplication.findMany({ select: { status: true } })
    ).map((a) => a.status);
    expect(statuses.sort()).toEqual(["APPROVED", "PENDING_REVIEW"]);
  });

  it("(b) an owner who already has an account is attached, and gets the 'you were added' email", async () => {
    const existingId = randomUUID();
    const email = "active@example.com";
    ensureUsersMock.mockResolvedValue(
      new Map([[email, identityUser(existingId, email, 1)]]),
    );
    const application = await seedPendingReview([
      { email, fullName: "Already Here", isLegalRep: true },
    ]);

    const result = await approve(application.id);

    expect(result.status).toBe("APPROVED");
    const membership = await prisma.organizationMember.findFirstOrThrow({
      where: { userId: existingId },
    });
    expect(membership).toMatchObject({
      organizationId: result.organizationId,
      role: "LEGAL_REPRESENTATIVE",
      source: "APPLICATION_APPROVAL",
      sourceRef: application.id,
      deletedAt: null,
    });
    const candidate = await prisma.organizationApplicationOwner.findFirstOrThrow({
      where: { applicationId: application.id },
    });
    expect(candidate.resolvedUserId).toBe(existingId);

    const [event] = await prisma.outboxEvent.findMany({
      where: { eventType: "ORG_OWNER_ONBOARD" },
    });
    expect(event.dedupKey).toBe(`ORG_OWNER_ONBOARD:${candidate.id}`);
    expect(event.payload).toMatchObject({ userId: existingId, email });

    // Identity reports the account as active → no activation token → attached branch.
    issueActivationTokenMock.mockResolvedValue(null);
    await organizationOwnerOnboardPublisher.publish({
      id: event.id,
      eventType: event.eventType,
      payload: event.payload,
    } as never);
    expect(activationEmailMock).not.toHaveBeenCalled();
    expect(attachedEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: email }),
    );
  });

  it("(c) an organization without an owner membership cannot be committed", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.organization.create({
          data: {
            name: "Orphan",
            slug: `orphan-${randomUUID()}`,
            logoUrl: "https://example.com/logo.png",
            status: 1,
          },
        });
      }),
    ).rejects.toThrow(/ORG_MUST_HAVE_OWNER/);

    expect(await prisma.organization.count()).toBe(0);
  });

  it("(d) the last owner membership can be neither soft-deleted nor deleted", async () => {
    const ownerId = randomUUID();
    const org = await seedOrganization(ownerId);
    const key = { organizationId_userId: { organizationId: org.id, userId: ownerId } };

    await expect(
      prisma.organizationMember.update({ where: key, data: { deletedAt: new Date() } }),
    ).rejects.toThrow(/ORG_MUST_HAVE_OWNER/);
    await expect(
      prisma.organizationMember.update({ where: key, data: { role: "MEMBER" } }),
    ).rejects.toThrow(/ORG_MUST_HAVE_OWNER/);
    await expect(prisma.organizationMember.delete({ where: key })).rejects.toThrow(
      /ORG_MUST_HAVE_OWNER/,
    );

    const membership = await prisma.organizationMember.findUniqueOrThrow({ where: key });
    expect(membership).toMatchObject({ role: "OWNER", deletedAt: null });
  });

  it("(d') with a second owner, one of them can step down", async () => {
    const a = randomUUID();
    const b = randomUUID();
    const org = await seedOrganization(a);
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: b, role: "OWNER" },
    });

    await prisma.organizationMember.update({
      where: { organizationId_userId: { organizationId: org.id, userId: a } },
      data: { deletedAt: new Date() },
    });

    expect(
      await prisma.organizationMember.count({
        where: { organizationId: org.id, deletedAt: null },
      }),
    ).toBe(1);
  });

  it("(e) an applied ADD_OWNER upgrades an existing MEMBER to OWNER, the org keeps its owners", async () => {
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const org = await seedOrganization(ownerId);
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: memberId, role: "MEMBER", source: "JOIN_REQUEST" },
    });
    // The candidate has confirmed; there is no other owner to ask.
    const proposal = await prisma.organizationApplication.create({
      data: {
        code: `ORG-${randomUUID().slice(0, 8).toUpperCase()}`,
        type: "ADD_OWNER",
        organizationId: org.id,
        orgType: "CLUB",
        status: "AWAITING_OWNER_CONFIRMATION",
        submitterEmail: "owner@clb.vn",
        submittedByUserId: ownerId,
        submittedAt: new Date(),
        consentedAt: new Date(),
        profile: { name: org.name, logoUrl: org.logoUrl },
        owners: {
          create: {
            email: "member@clb.vn",
            fullName: "Member",
            status: "CONFIRMED",
            respondedAt: new Date(),
          },
        },
      },
    });
    ensureUsersMock.mockResolvedValue(
      new Map([["member@clb.vn", identityUser(memberId, "member@clb.vn")]]),
    );

    await expect(ownerChangeExecutor.tryFinalize(proposal.id)).resolves.toBe("APPROVED");

    const members = await prisma.organizationMember.findMany({
      where: { organizationId: org.id, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
    expect(members.map((m) => [m.userId, m.role])).toEqual([
      [ownerId, "OWNER"],
      [memberId, "OWNER"],
    ]);
    const upgraded = members.find((m) => m.userId === memberId)!;
    expect(upgraded.source).toBe("APPLICATION_APPROVAL");
    expect(upgraded.sourceRef).toBe(proposal.id);

    // The organization's own application link is untouched by the proposal.
    const orgAfter = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(orgAfter.applicationId).toBeNull();
    expect(
      await prisma.outboxEvent.count({ where: { eventType: "ORG_OWNER_ONBOARD" } }),
    ).toBe(1);
  });

  it("(g) an ADD_OWNER that fails after granting the first person rolls back: nobody is added", async () => {
    const ownerId = randomUUID();
    const firstId = randomUUID();
    const secondId = randomUUID();
    const org = await seedOrganization(ownerId);
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: firstId, role: "MEMBER", source: "JOIN_REQUEST" },
    });
    const proposal = await prisma.organizationApplication.create({
      data: {
        code: `ORG-${randomUUID().slice(0, 8).toUpperCase()}`,
        type: "ADD_OWNER",
        organizationId: org.id,
        orgType: "CLUB",
        status: "AWAITING_OWNER_CONFIRMATION",
        submitterEmail: "owner@clb.vn",
        submittedByUserId: ownerId,
        submittedAt: new Date(),
        consentedAt: new Date(),
        profile: { name: org.name, logoUrl: org.logoUrl },
        owners: {
          create: [
            { email: "first@clb.vn", fullName: "First", status: "CONFIRMED", respondedAt: new Date() },
            { email: "second@clb.vn", fullName: "Second", status: "CONFIRMED", respondedAt: new Date() },
          ],
        },
      },
    });
    ensureUsersMock.mockResolvedValue(
      new Map([
        ["first@clb.vn", identityUser(firstId, "first@clb.vn")],
        ["second@clb.vn", identityUser(secondId, "second@clb.vn")],
      ]),
    );

    // Granting the second person — after the first was upgraded — blows up mid-transaction.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION it_fail_grant() RETURNS trigger AS $$
      BEGIN
        IF NEW."user_id" = '${secondId}'::uuid THEN
          RAISE EXCEPTION 'simulated crash while granting';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER it_fail_grant BEFORE INSERT OR UPDATE ON "organization_members" FOR EACH ROW EXECUTE FUNCTION it_fail_grant()`,
    );
    try {
      await expect(ownerChangeExecutor.tryFinalize(proposal.id)).resolves.toBe(
        "AWAITING_OWNER_CONFIRMATION",
      );
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS it_fail_grant ON "organization_members"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS it_fail_grant()`);
    }

    const members = await prisma.organizationMember.findMany({
      where: { organizationId: org.id, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
    expect(members.map((m) => [m.userId, m.role])).toEqual([
      [ownerId, "OWNER"],
      [firstId, "MEMBER"],
    ]);
    expect(await prisma.outboxEvent.count({ where: { eventType: "ORG_OWNER_ONBOARD" } })).toBe(0);

    // Retried later (the sweeper's job) it goes through cleanly.
    await expect(ownerChangeExecutor.tryFinalize(proposal.id)).resolves.toBe("APPROVED");
    const after = await prisma.organizationMember.findMany({
      where: { organizationId: org.id, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
    expect(after.map((m) => [m.userId, m.role])).toEqual([
      [ownerId, "OWNER"],
      [firstId, "OWNER"],
      [secondId, "OWNER"],
    ]);
  });

  it("(h) two owners leaving at the same moment: exactly one succeeds, the other ORG_MUST_HAVE_OWNER", async () => {
    const a = randomUUID();
    const b = randomUUID();
    const org = await seedOrganization(a);
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: b, role: "OWNER" },
    });

    const results = await Promise.allSettled([
      organizationService.leaveOrganization(org.id, a),
      organizationService.leaveOrganization(org.id, b),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ statusResponse: { code: "ORG_MUST_HAVE_OWNER" } });
    expect(
      await prisma.organizationMember.count({
        where: { organizationId: org.id, deletedAt: null, role: "OWNER" },
      }),
    ).toBe(1);
  });

  it("(i) the two owners of a 2-owner org removing each other at once: exactly one removal applies", async () => {
    const a = randomUUID();
    const b = randomUUID();
    const org = await seedOrganization(a);
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: b, role: "OWNER" },
    });

    await Promise.allSettled([
      ownerChangeService.create(org.id, a, "a@clb.vn", {
        type: "REMOVE_OWNER",
        targetUserId: b,
      }),
      ownerChangeService.create(org.id, b, "b@clb.vn", {
        type: "REMOVE_OWNER",
        targetUserId: a,
      }),
    ]);

    const owners = await prisma.organizationMember.findMany({
      where: { organizationId: org.id, deletedAt: null, role: "OWNER" },
    });
    expect(owners).toHaveLength(1);
    const changes = await prisma.organizationApplication.findMany({
      where: { organizationId: org.id, type: "REMOVE_OWNER" },
    });
    expect(changes).toHaveLength(2);
    expect(changes.filter((c) => c.status === "APPROVED")).toHaveLength(1);
    const winner = changes.find((c) => c.status === "APPROVED")!;
    expect(winner.submittedByUserId).toBe(owners[0].userId);
    expect(changes.find((c) => c.status !== "APPROVED")!.status).toMatch(/REJECTED|WITHDRAWN/);
  });

  it("(j) the last owner can neither leave nor step down, and nothing is written", async () => {
    const ownerId = randomUUID();
    const org = await seedOrganization(ownerId);
    const before = await prisma.organizationMember.findUniqueOrThrow({
      where: { organizationId_userId: { organizationId: org.id, userId: ownerId } },
    });

    await expect(organizationService.leaveOrganization(org.id, ownerId)).rejects.toMatchObject({
      statusResponse: { code: "ORG_MUST_HAVE_OWNER" },
    });
    await expect(organizationService.stepDown(org.id, ownerId, "ADMIN")).rejects.toMatchObject({
      statusResponse: { code: "ORG_MUST_HAVE_OWNER" },
    });
    await expect(
      ownerChangeService.create(org.id, ownerId, "owner@clb.vn", {
        type: "REMOVE_OWNER",
        targetUserId: ownerId,
      }),
    ).rejects.toMatchObject({ statusResponse: { code: "CANNOT_TARGET_SELF" } });

    const after = await prisma.organizationMember.findUniqueOrThrow({
      where: { organizationId_userId: { organizationId: org.id, userId: ownerId } },
    });
    expect(after).toEqual(before);
    expect(await prisma.organizationApplication.count()).toBe(0);
  });

  it("(k) the legal representative is replaced: the replacement becomes LR, the old LR a member", async () => {
    const lrId = randomUUID();
    const memberId = randomUUID();
    const org = await prisma.organization.create({
      data: {
        name: `Org ${randomUUID()}`,
        slug: `org-${randomUUID()}`,
        logoUrl: "https://example.com/logo.png",
        status: 1,
        members: {
          create: [
            { userId: lrId, role: "LEGAL_REPRESENTATIVE", source: "INTERNAL" },
            { userId: memberId, role: "MEMBER", source: "JOIN_REQUEST" },
          ],
        },
      },
    });
    const change = await prisma.organizationApplication.create({
      data: {
        code: `ORG-${randomUUID().slice(0, 8).toUpperCase()}`,
        type: "REMOVE_OWNER",
        organizationId: org.id,
        orgType: "CLUB",
        status: "AWAITING_OWNER_CONFIRMATION",
        submitterEmail: "lr@clb.vn",
        submittedByUserId: lrId,
        targetUserId: lrId,
        demoteToRole: "MEMBER",
        submittedAt: new Date(),
        consentedAt: new Date(),
        profile: { name: org.name, logoUrl: org.logoUrl },
        owners: {
          create: {
            email: "member@clb.vn",
            fullName: "Member",
            isLegalRep: true,
            status: "CONFIRMED",
            respondedAt: new Date(),
          },
        },
      },
    });
    ensureUsersMock.mockResolvedValue(
      new Map([["member@clb.vn", identityUser(memberId, "member@clb.vn")]]),
    );

    await expect(ownerChangeExecutor.tryFinalize(change.id)).resolves.toBe("APPROVED");

    const members = await prisma.organizationMember.findMany({
      where: { organizationId: org.id, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
    expect(Object.fromEntries(members.map((m) => [m.userId, m.role]))).toEqual({
      [lrId]: "MEMBER",
      [memberId]: "LEGAL_REPRESENTATIVE",
    });
    expect(
      await prisma.outboxEvent.count({ where: { eventType: "ORG_OWNER_ONBOARD" } }),
    ).toBe(1);
  });

  it("(f) two concurrent accepts of the same invitation create exactly one membership", async () => {
    const ownerId = randomUUID();
    const inviteeId = randomUUID();
    const org = await seedOrganization(ownerId);
    await prisma.organizationInvitation.create({
      data: {
        organizationId: org.id,
        inviterId: ownerId,
        inviteeUserId: inviteeId,
        inviteeEmail: "binh@gmail.com",
        status: "SENT",
        approvedBy: ownerId,
        approvedAt: new Date(),
        tokenHash: hashOpaqueToken("raw-invite"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const results = await Promise.allSettled([
      organizationInvitationService.accept("raw-invite"),
      organizationInvitationService.accept("raw-invite"),
    ]);

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const memberships = await prisma.organizationMember.findMany({
      where: { organizationId: org.id, userId: inviteeId },
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ role: "MEMBER", source: "INVITATION", deletedAt: null });
    const invitation = await prisma.organizationInvitation.findFirstOrThrow({
      where: { organizationId: org.id },
    });
    expect(invitation.status).toBe("ACCEPTED");
  });
});
