import { Prisma } from "@prisma/client";
import {
  ApplicationEventType,
  ApplicationStatus,
  ApplicationType,
  MembershipSource,
  OWNER_CHANGE_TYPES,
  OWNER_ROLES,
  OrgMemberRole,
  OwnerApprovalStatus,
  OwnerCandidateStatus,
  isOwnerRole,
} from "@da2/constants";
import prisma from "../../config/prisma.client";
import { HTTP_STATUS, HttpError } from "../../constants/http-status";
import { emitOutbox } from "../../outbox/outbox.writer";
import { OutboxEventType } from "../../outbox/outbox.types";
import { enqueueOrgMembershipChangedWebsiteNotification } from "../organization/organization-member-notify.client";
import {
  isOrgMustHaveOwnerViolation,
  organizationMembershipService,
} from "../organization/organization-membership.service";
import {
  IdentityUserStatus,
  IdentityUserSummary,
  ensureUsers,
} from "./identity-owner.client";
import { enqueueApplicationWithdrawnNoticeEmail } from "./organization-application-notify.client";
import { organizationApplicationRepository } from "./organization-application.repository";
import { buildOrganizationManageUrl } from "./organization-application-urls";
import {
  OwnerChangeNoticeBase,
  OwnerChangeOutcome,
  notifyDecided,
} from "./owner-change-notify.client";
import { onMemberGone, onRightsReduced } from "../campaign/campaign_manager/campaign-team-cleanup";

const OPEN = ApplicationStatus.AWAITING_OWNER_CONFIRMATION;
const OWNER_ROLE_VALUES: string[] = [...OWNER_ROLES];
const OWNER_CHANGE_TYPE_VALUES: string[] = [...OWNER_CHANGE_TYPES];
/** `reconcileOpenChanges` → `tryFinalize` → `reconcileOpenChanges` … stops here. */
const MAX_CASCADE_DEPTH = 3;

const CHANGE_INCLUDE = {
  owners: { where: { removedAt: null }, orderBy: { createdAt: "asc" as const } },
  approvals: { orderBy: { createdAt: "asc" as const } },
};

export type OwnerChangeRow = Prisma.OrganizationApplicationGetPayload<{
  include: typeof CHANGE_INCLUDE;
}>;

/** What the proposer typed and what the notices display, kept on `profile`. */
export interface OwnerChangeProfile {
  name?: string;
  logoUrl?: string;
  address?: string | null;
  contactEmail?: string | null;
  proposalReason?: string | null;
  proposerName?: string | null;
  subjectNames?: string | null;
}

/** A check that makes the change impossible for good (not a transient outage). */
class OwnerChangeFailure extends Error {}

export function loadOwnerChange(id: string, client: Prisma.TransactionClient = prisma) {
  return client.organizationApplication.findFirst({
    where: { id, deletedAt: null },
    include: CHANGE_INCLUDE,
  });
}

async function ownerIdsOf(
  client: Prisma.TransactionClient,
  organizationId: string,
): Promise<Set<string>> {
  const rows = await client.organizationMember.findMany({
    where: { organizationId, deletedAt: null, role: { in: OWNER_ROLE_VALUES } },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId));
}

/**
 * Every condition met: each person concerned confirmed by email, and each co-owner asked
 * approved. An approver who has since stopped being an owner no longer counts.
 */
export function isOwnerChangeReady(change: OwnerChangeRow, ownerIds: Set<string>): boolean {
  if (change.status !== OPEN) return false;
  if (change.type !== ApplicationType.REMOVE_OWNER && change.owners.length === 0) {
    return false;
  }
  if (change.owners.some((o) => o.status !== OwnerCandidateStatus.CONFIRMED)) return false;
  return change.approvals.every(
    (a) =>
      a.status === OwnerApprovalStatus.APPROVED ||
      (a.status === OwnerApprovalStatus.PENDING && !ownerIds.has(a.approverUserId)),
  );
}

async function roleOf(
  tx: Prisma.TransactionClient,
  organizationId: string,
  userId: string | null,
): Promise<string | null> {
  if (!userId) return null;
  const row = await tx.organizationMember.findFirst({
    where: { organizationId, userId, deletedAt: null },
    select: { role: true },
  });
  return row?.role ?? null;
}

/** Keeps the person with a lesser role, or removes them when `role` is null. */
async function demoteOrRemove(
  tx: Prisma.TransactionClient,
  organizationId: string,
  userId: string,
  role: string | null,
  actorId: string | null,
): Promise<void> {
  const where = { organizationId_userId: { organizationId, userId } };
  if (role) {
    await tx.organizationMember.update({ where, data: { role, updatedBy: actorId } });
    await onRightsReduced(tx, organizationId, userId, actorId ?? userId);
  } else {
    await tx.organizationMember.update({
      where,
      data: { deletedAt: new Date(), updatedBy: actorId },
    });
    await onMemberGone(tx, organizationId, userId, actorId ?? userId);
  }
}

/** Why the change can never be applied, or null for a transient error worth retrying. */
function permanentFailureReason(error: unknown): string | null {
  if (error instanceof OwnerChangeFailure) return error.message;
  if (HttpError.isHttpError(error)) return error.message;
  if (isOrgMustHaveOwnerViolation(error)) return HTTP_STATUS.ORG_MUST_HAVE_OWNER.message;
  return null;
}

interface AppliedChange {
  change: OwnerChangeRow;
  organization: { id: string; name: string; slug: string };
  /** Members whose own role changed (not the new owners of ADD_OWNER: they get onboarding). */
  roleChanges: { userId: string; role: string | null }[];
  ownersAfter: Set<string>;
}

/**
 * Applies owner changes once every condition is met, and keeps the other open changes of the
 * organization consistent after one is applied or an owner steps down.
 *
 * `tryFinalize` is called after the transaction of whatever might have completed the change
 * (creation, an approval, a candidate's confirmation, an owner leaving) has committed, and by
 * the hourly sweeper for changes whose application failed on a transient error.
 */
export class OwnerChangeExecutor {
  async tryFinalize(applicationId: string, depth = 0): Promise<string | null> {
    const change = await loadOwnerChange(applicationId);
    if (
      !change ||
      !OWNER_CHANGE_TYPE_VALUES.includes(change.type) ||
      change.status !== OPEN ||
      !change.organizationId
    ) {
      return change?.status ?? null;
    }
    const organizationId = change.organizationId;
    if (!isOwnerChangeReady(change, await ownerIdsOf(prisma, organizationId))) {
      return change.status;
    }

    // Accounts for new owners are found or created outside the transaction (identity-service
    // is another database); idempotent, so a failed attempt only leaves unactivated accounts
    // the next one reuses.
    let users = new Map<string, IdentityUserSummary>();
    // New owners, or the legal representative's replacement.
    if (change.owners.length > 0) {
      try {
        users = await ensureUsers(
          change.owners.map((c) => ({ email: c.email, fullName: c.fullName })),
        );
      } catch (error) {
        console.error("[owner-change] ensure-users failed; the sweeper retries", error);
        return change.status;
      }
    }

    let applied: AppliedChange | null;
    try {
      applied = await prisma.$transaction((tx) =>
        this.applyLocked(tx, applicationId, organizationId, users),
      );
    } catch (error) {
      const reason = permanentFailureReason(error);
      if (reason === null) {
        console.error("[owner-change] applying failed; the sweeper retries", error);
        return change.status;
      }
      await this.end(applicationId, {
        status: ApplicationStatus.REJECTED,
        reason,
        actorId: null,
      });
      return ApplicationStatus.REJECTED;
    }
    if (!applied) {
      return (await loadOwnerChange(applicationId))?.status ?? null;
    }

    this.notifyApplied(applied);
    if (depth < MAX_CASCADE_DEPTH) {
      await this.reconcileOpenChanges(organizationId, depth + 1);
    }
    return ApplicationStatus.APPROVED;
  }

  private async applyLocked(
    tx: Prisma.TransactionClient,
    applicationId: string,
    organizationId: string,
    users: Map<string, IdentityUserSummary>,
  ): Promise<AppliedChange | null> {
    await organizationApplicationRepository.lockForUpdate(tx, applicationId);
    const change = await loadOwnerChange(applicationId, tx);
    if (!change || change.status !== OPEN) return null;
    // Serializes every owner-role change of this organization (other changes, owners stepping
    // down): two owners removing each other at the same moment cannot both win.
    const lockedOwners = await tx.$queryRaw<{ user_id: string }[]>`
      SELECT "user_id" FROM "organization_members"
      WHERE "organization_id" = ${organizationId}::uuid
        AND "deleted_at" IS NULL
        AND "role" IN ('LEGAL_REPRESENTATIVE', 'OWNER')
      FOR UPDATE`;
    const ownerIds = new Set(lockedOwners.map((o) => o.user_id));
    if (!isOwnerChangeReady(change, ownerIds)) return null;
    if (!change.submittedByUserId || !ownerIds.has(change.submittedByUserId)) {
      throw new OwnerChangeFailure("Người đề xuất không còn là owner.");
    }

    const organization = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true, slug: true, deletedAt: true },
    });
    if (!organization || organization.deletedAt) {
      throw new OwnerChangeFailure("The organization no longer exists");
    }

    const actorId = change.submittedByUserId;
    const roleChanges: AppliedChange["roleChanges"] = [];
    const granted: string[] = [];

    if (change.type === ApplicationType.ADD_OWNER) {
      for (const candidate of change.owners) {
        const user = users.get(candidate.email);
        if (!user) {
          // identity-service answered without this account: transient, retried later.
          throw new Error(`Identity service returned no account for ${candidate.email}`);
        }
        if (user.status === IdentityUserStatus.INACTIVE) {
          throw new HttpError(
            HTTP_STATUS.OWNER_SUSPENDED.withMessage(
              `${HTTP_STATUS.OWNER_SUSPENDED.message}: ${candidate.email}`,
            ),
          );
        }
        // Became an owner some other way meanwhile: nothing to grant.
        if (!isOwnerRole(await roleOf(tx, organizationId, user.id))) {
          await organizationMembershipService.assertOwnerQuota(tx, user.id, candidate.email);
          await organizationMembershipService.grantMembership(tx, {
            userId: user.id,
            organizationId,
            role: OrgMemberRole.OWNER,
            source: MembershipSource.APPLICATION_APPROVAL,
            sourceRef: change.id,
            actorId,
          });
          granted.push(user.id);
        }
        await tx.organizationApplicationOwner.update({
          where: { id: candidate.id },
          data: { resolvedUserId: user.id },
        });
        await emitOutbox(tx, {
          aggregateType: "organization_application",
          aggregateId: change.id,
          eventType: OutboxEventType.ORG_OWNER_ONBOARD,
          dedupKey: `${OutboxEventType.ORG_OWNER_ONBOARD}:${candidate.id}`,
          payload: {
            applicationId: change.id,
            candidateId: candidate.id,
            organizationId,
            organizationName: organization.name,
            organizationSlug: organization.slug,
            userId: user.id,
            email: candidate.email,
            fullName: candidate.fullName,
            isLegalRep: false,
          },
        });
      }
    } else if (change.type === ApplicationType.REMOVE_OWNER) {
      const targetId = change.targetUserId;
      if (!targetId || !isOwnerRole(await roleOf(tx, organizationId, targetId))) {
        throw new HttpError(HTTP_STATUS.TARGET_NOT_OWNER);
      }
      // Replacing the legal representative: the replacement takes the role first.
      const replacement = change.owners.find((c) => c.isLegalRep);
      if (replacement) {
        const user = users.get(replacement.email);
        if (!user) {
          throw new Error(`Identity service returned no account for ${replacement.email}`);
        }
        if (user.status === IdentityUserStatus.INACTIVE) {
          throw new HttpError(
            HTTP_STATUS.OWNER_SUSPENDED.withMessage(
              `${HTTP_STATUS.OWNER_SUSPENDED.message}: ${replacement.email}`,
            ),
          );
        }
        const wasOwner = isOwnerRole(await roleOf(tx, organizationId, user.id));
        if (!wasOwner) {
          await organizationMembershipService.assertOwnerQuota(tx, user.id, replacement.email);
        }
        await organizationMembershipService.grantMembership(tx, {
          userId: user.id,
          organizationId,
          role: OrgMemberRole.LEGAL_REPRESENTATIVE,
          source: MembershipSource.APPLICATION_APPROVAL,
          sourceRef: change.id,
          actorId,
        });
        await tx.organizationApplicationOwner.update({
          where: { id: replacement.id },
          data: { resolvedUserId: user.id },
        });
        if (wasOwner) {
          roleChanges.push({ userId: user.id, role: OrgMemberRole.LEGAL_REPRESENTATIVE });
        } else {
          granted.push(user.id);
          await emitOutbox(tx, {
            aggregateType: "organization_application",
            aggregateId: change.id,
            eventType: OutboxEventType.ORG_OWNER_ONBOARD,
            dedupKey: `${OutboxEventType.ORG_OWNER_ONBOARD}:${replacement.id}`,
            payload: {
              applicationId: change.id,
              candidateId: replacement.id,
              organizationId,
              organizationName: organization.name,
              organizationSlug: organization.slug,
              userId: user.id,
              email: replacement.email,
              fullName: replacement.fullName,
              isLegalRep: true,
            },
          });
        }
      }
      await demoteOrRemove(tx, organizationId, targetId, change.demoteToRole, actorId);
      roleChanges.push({ userId: targetId, role: change.demoteToRole });
    }

    const now = new Date();
    await tx.organizationApplication.update({
      where: { id: change.id },
      data: { status: ApplicationStatus.APPROVED, reviewedAt: now },
    });
    await organizationApplicationRepository.recordEvent({
      tx,
      applicationId: change.id,
      eventType: ApplicationEventType.OWNER_CHANGE_APPLIED,
      actorId,
      payload: {
        type: change.type,
        organizationId,
        grantedOwnerUserIds: granted,
        roleChanges,
      },
    });

    return {
      change,
      organization,
      roleChanges,
      ownersAfter: await ownerIdsOf(tx, organizationId),
    };
  }

  /**
   * Closes an open change (rejected by a co-owner, cancelled, impossible to apply, overtaken
   * by another change). Returns false when it was no longer open.
   */
  async end(
    applicationId: string,
    params: {
      status: ApplicationStatus.REJECTED | ApplicationStatus.WITHDRAWN;
      reason: string;
      actorId: string | null;
    },
  ): Promise<boolean> {
    const ended = await prisma.$transaction(async (tx) => {
      await organizationApplicationRepository.lockForUpdate(tx, applicationId);
      const change = await loadOwnerChange(applicationId, tx);
      if (!change || change.status !== OPEN) return null;
      const now = new Date();
      await tx.organizationApplication.update({
        where: { id: change.id },
        data: {
          status: params.status,
          reviewedAt: now,
          ...(params.status === ApplicationStatus.REJECTED
            ? { rejectReason: params.reason }
            : { reviewNote: params.reason }),
        },
      });
      // Pending links stop working; the hash stays so they explain themselves.
      await tx.organizationApplicationOwner.updateMany({
        where: { applicationId: change.id, status: OwnerCandidateStatus.PENDING },
        data: { expiresAt: now },
      });
      await organizationApplicationRepository.recordEvent({
        tx,
        applicationId: change.id,
        eventType:
          params.status === ApplicationStatus.REJECTED
            ? ApplicationEventType.REJECTED
            : ApplicationEventType.WITHDRAWN,
        actorId: params.actorId,
        payload: { reason: params.reason },
      });
      return change;
    });
    if (!ended) return false;

    const organization = ended.organizationId
      ? await prisma.organization.findUnique({
          where: { id: ended.organizationId },
          select: { id: true, name: true, slug: true },
        })
      : null;
    if (organization) {
      const outcome: OwnerChangeOutcome =
        params.status === ApplicationStatus.REJECTED ? "rejected" : "withdrawn";
      notifyDecided(
        [
          ended.submittedByUserId,
          ended.type === ApplicationType.REMOVE_OWNER ? ended.targetUserId : null,
          ...ended.approvals
            .filter((a) => a.status === OwnerApprovalStatus.APPROVED)
            .map((a) => a.approverUserId),
        ].filter((id): id is string => Boolean(id) && id !== params.actorId),
        { ...this.noticeBase(ended, organization), outcome, reason: params.reason },
      );
    }
    // People who already confirmed by email would otherwise wonder why nothing happened.
    const name = ((ended.profile ?? {}) as OwnerChangeProfile).name ?? ended.code;
    for (const owner of ended.owners.filter(
      (o) => o.status === OwnerCandidateStatus.CONFIRMED,
    )) {
      void enqueueApplicationWithdrawnNoticeEmail({
        toEmail: owner.email,
        organizationName: name,
        submitterEmail: ended.submitterEmail,
      }).catch((err) => {
        console.warn("[owner-change] failed to send a cancellation notice", err);
      });
    }
    return true;
  }

  /**
   * After any owner-role change in the organization: changes whose proposer or target no
   * longer fits are cancelled; the rest may have just become ready (an approver
   * left), so they are tried again.
   */
  async reconcileOpenChanges(organizationId: string, depth = 0): Promise<void> {
    const open = await prisma.organizationApplication.findMany({
      where: {
        organizationId,
        type: { in: OWNER_CHANGE_TYPE_VALUES },
        status: OPEN,
        deletedAt: null,
      },
      select: { id: true, type: true, submittedByUserId: true, targetUserId: true },
      orderBy: { createdAt: "asc" },
    });
    if (open.length === 0) return;

    for (const change of open) {
      const members = await prisma.organizationMember.findMany({
        where: { organizationId, deletedAt: null },
        select: { userId: true, role: true },
      });
      const roles = new Map(members.map((m) => [m.userId, m.role]));
      let reason: string | null = null;
      if (!isOwnerRole(roles.get(change.submittedByUserId ?? ""))) {
        reason = "Người đề xuất không còn là owner.";
      } else if (
        change.type === ApplicationType.REMOVE_OWNER &&
        !isOwnerRole(roles.get(change.targetUserId ?? ""))
      ) {
        reason = "Người bị đề xuất thu hồi không còn là owner.";
      }
      if (reason) {
        await this.end(change.id, {
          status: ApplicationStatus.WITHDRAWN,
          reason,
          actorId: null,
        });
      } else {
        await this.tryFinalize(change.id, depth);
      }
    }
  }

  /**
   * Hourly: co-owners who let their 14 days run out cancel the change; changes that became
   * ready but failed on a transient error are applied now.
   */
  async sweep(now = new Date()): Promise<{ expired: number; applied: number }> {
    const open = await prisma.organizationApplication.findMany({
      where: { type: { in: OWNER_CHANGE_TYPE_VALUES }, status: OPEN, deletedAt: null },
      select: { id: true },
    });
    let expired = 0;
    let applied = 0;
    for (const { id } of open) {
      try {
        const change = await loadOwnerChange(id);
        if (!change?.organizationId) continue;
        const owners = await ownerIdsOf(prisma, change.organizationId);
        const overdue = change.approvals.filter(
          (a) =>
            a.status === OwnerApprovalStatus.PENDING &&
            a.expiresAt < now &&
            owners.has(a.approverUserId),
        );
        if (overdue.length > 0) {
          await prisma.organizationOwnerChangeApproval.updateMany({
            where: { id: { in: overdue.map((a) => a.id) } },
            data: { status: OwnerApprovalStatus.EXPIRED },
          });
          const ended = await this.end(id, {
            status: ApplicationStatus.WITHDRAWN,
            reason: "Có owner không trả lời kịp hạn.",
            actorId: null,
          });
          if (ended) expired += 1;
          continue;
        }
        if ((await this.tryFinalize(id)) === ApplicationStatus.APPROVED) applied += 1;
      } catch (error) {
        console.error(`[owner-change] sweep failed for ${id}`, error);
      }
    }
    return { expired, applied };
  }

  noticeBase(
    change: Pick<OwnerChangeRow, "type" | "demoteToRole" | "profile">,
    organization: { id: string; name: string; slug: string },
  ): OwnerChangeNoticeBase {
    const profile = (change.profile ?? {}) as OwnerChangeProfile;
    return {
      type: change.type,
      organizationId: organization.id,
      organizationName: organization.name,
      organizationSlug: organization.slug,
      subjectNames: profile.subjectNames ?? "",
      demoteTo: change.demoteToRole,
      manageUrl: buildOrganizationManageUrl(organization.slug),
    };
  }

  private notifyApplied(applied: AppliedChange): void {
    const { change, organization, roleChanges, ownersAfter } = applied;
    const base = this.noticeBase(change, organization);
    const changedIds = new Set(roleChanges.map((r) => r.userId));

    // Everyone who now owns the organization learns about it, except the people whose own
    // role changed (they get the personal notice below).
    notifyDecided(
      [...ownersAfter, change.submittedByUserId]
        .filter((id): id is string => Boolean(id))
        .filter((id) => !changedIds.has(id)),
      { ...base, outcome: "approved", reason: "" },
    );
    for (const { userId, role } of roleChanges) {
      void enqueueOrgMembershipChangedWebsiteNotification({
        userId,
        organizationId: organization.id,
        organizationName: organization.name,
        organizationSlug: organization.slug,
        ...(role ? { role } : { removed: true }),
      }).catch((err) => {
        console.warn("[owner-change] failed to notify a member of their new role", err);
      });
    }
  }
}

export const ownerChangeExecutor = new OwnerChangeExecutor();
