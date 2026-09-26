/**
 * Multi-owner organizations against a real Postgres.
 *
 * The four cases the design calls "silent failures" — they run without an error and leave
 * the data wrong — so they are proven here rather than with mocks:
 *   (a) two concurrent approvals for someone at 2 organizations → exactly one wins
 *   (b) an owner who already has an account is attached, not re-created
 *   (c) an organization cannot be committed without an owner membership
 *   (d) the last owner membership cannot be removed
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

jest.mock("../modules/organization_application/identity-owner.client", () => ({
  IdentityUserStatus: { ACTIVE: 1, INACTIVE: 2, PENDING_ACTIVATION: 3 },
  ensureUsers: (...a: unknown[]) => ensureUsersMock(...a),
  lookupUsersByEmails: (...a: unknown[]) => lookupUsersMock(...a),
  issueActivationToken: (...a: unknown[]) => issueActivationTokenMock(...a),
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
}));

import { organizationApplicationAdminService } from "../modules/organization_application/organization-application-admin.service";
import { organizationOwnerOnboardPublisher } from "../modules/organization_application/organization-owner-onboard.publisher";

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
});
