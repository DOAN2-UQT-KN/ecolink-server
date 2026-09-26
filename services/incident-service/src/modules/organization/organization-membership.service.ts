import { Prisma } from "@prisma/client";
import {
  GlobalStatus,
  MembershipSource,
  OWNER_ORG_LIMIT,
  OWNER_ROLES,
  OrgMemberRole,
} from "@da2/constants";
import { HTTP_STATUS, HttpError } from "../../constants/http-status";

const OWNER_ROLE_VALUES: string[] = [...OWNER_ROLES];

/**
 * Writes to `organization_members` that grant a role. Everything that hands someone power
 * over an organization goes through here, so the invariants live in one place:
 *
 *   - one role per person per organization (primary key)
 *   - at most `OWNER_ORG_LIMIT` owner memberships per person (`assertOwnerQuota`)
 *   - no grant into a suspended organization
 *   - at least one owner per organization (DB trigger, checked at commit)
 */
export class OrganizationMembershipService {
  /**
   * Counts the user's owner memberships under a per-user advisory lock. Two admins approving
   * two applications for the same person at the same time would both pass a plain `count()`;
   * with the lock the second transaction waits for the first to commit and then sees its row.
   *
   * The lock is on the user id rather than a `users` row because users live in
   * identity-service's database; memberships, and therefore the count, live here.
   */
  async assertOwnerQuota(
    tx: Prisma.TransactionClient,
    userId: string,
    email?: string,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}::text, 0))`;

    const count = await tx.organizationMember.count({
      where: {
        userId,
        deletedAt: null,
        role: { in: OWNER_ROLE_VALUES },
        organization: { deletedAt: null },
      },
    });

    if (count >= OWNER_ORG_LIMIT) {
      throw new HttpError(
        HTTP_STATUS.OWNER_QUOTA_EXCEEDED.withMessage(
          email
            ? `${email} already owns ${count} organizations (limit ${OWNER_ORG_LIMIT})`
            : `This person already owns ${count} organizations (limit ${OWNER_ORG_LIMIT})`,
        ),
      );
    }
  }

  async grantMembership(
    tx: Prisma.TransactionClient,
    params: {
      userId: string;
      organizationId: string;
      role: OrgMemberRole;
      source: MembershipSource;
      sourceRef?: string | null;
      actorId?: string | null;
    },
  ) {
    const organization = await tx.organization.findUnique({
      where: { id: params.organizationId },
      select: { status: true, deletedAt: true },
    });
    if (
      !organization ||
      organization.deletedAt ||
      organization.status !== GlobalStatus._STATUS_ACTIVE
    ) {
      throw new HttpError(
        HTTP_STATUS.CONFLICT.withMessage(
          "Roles cannot be granted in an inactive organization",
        ),
      );
    }

    return tx.organizationMember.upsert({
      where: {
        organizationId_userId: {
          organizationId: params.organizationId,
          userId: params.userId,
        },
      },
      create: {
        organizationId: params.organizationId,
        userId: params.userId,
        role: params.role,
        source: params.source,
        sourceRef: params.sourceRef ?? null,
        createdBy: params.actorId ?? null,
      },
      update: {
        role: params.role,
        source: params.source,
        sourceRef: params.sourceRef ?? null,
        deletedAt: null,
        updatedBy: params.actorId ?? null,
      },
    });
  }
}

/** Postgres raises this from `assert_org_has_owner` when a commit would orphan an organization. */
export function isOrgMustHaveOwnerViolation(error: unknown): boolean {
  const text =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return text.includes("ORG_MUST_HAVE_OWNER");
}

export const organizationMembershipService = new OrganizationMembershipService();
