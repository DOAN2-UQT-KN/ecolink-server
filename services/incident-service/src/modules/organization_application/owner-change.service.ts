import {
  ApplicationEventType,
  ApplicationStatus,
  ApplicationType,
  OWNER_CHANGE_TYPES,
  OWNER_CONFIRM_TTL_DAYS,
  OrgMemberRole,
  OrgPermission,
  OwnerApprovalStatus,
  OwnerCandidateStatus,
  isOwnerRole,
} from "@da2/constants";
import prisma from "../../config/prisma.client";
import { HTTP_STATUS, HttpError } from "../../constants/http-status";
import { orgAccessService } from "../organization/org-access.service";
import { organizationRepository } from "../organization/organization.repository";
import { organizationMemberRepository } from "../organization/organization_member.repository";
import { lookupUsersByEmails, lookupUsersByIds } from "./identity-owner.client";
import { OwnerCandidateResponse } from "./organization-application.dto";
import { organizationApplicationRepository } from "./organization-application.repository";
import { organizationApplicationService } from "./organization-application.service";
import {
  CandidateRow,
  newConfirmToken,
  normalizeOwnerInputs,
  sendConfirmationEmails,
  toOwnerCandidateResponse,
} from "./owner-candidates";
import {
  OwnerChangeProfile,
  OwnerChangeRow,
  ownerChangeExecutor,
} from "./owner-change-executor";
import { notifyApprovalRequested, notifyRemovalProposed } from "./owner-change-notify.client";

const OPEN = ApplicationStatus.AWAITING_OWNER_CONFIRMATION;
const OWNER_CHANGE_TYPE_VALUES: string[] = [...OWNER_CHANGE_TYPES];
/** Roles a removed owner may keep. */
const DEMOTE_ROLES: string[] = [OrgMemberRole.ADMIN, OrgMemberRole.MEMBER];
const DAY_MS = 24 * 60 * 60 * 1000;

export interface OwnerProposalInput {
  /** An existing account; its email is looked up. */
  userId?: string;
  /** Someone without an account (or an account picked by email). */
  email?: string;
  fullName: string;
}

export interface OwnerChangeInput {
  type: string;
  reason?: string | null;
  /** ADD_OWNER */
  owners?: OwnerProposalInput[];
  /** REMOVE_OWNER: the owner to remove. */
  targetUserId?: string;
  /** REMOVE_OWNER: role the removed owner keeps; defaults to MEMBER. */
  demoteTo?: string | null;
  /**
   * REMOVE_OWNER of the legal representative (required then, refused otherwise): who takes
   * the role over — a current owner, an existing account, or a new email.
   */
  replacement?: OwnerProposalInput | null;
}

interface PersonRef {
  userId: string;
  name: string | null;
  avatar: string | null;
}

export interface OwnerChangeApprovalResponse extends PersonRef {
  status: string;
  note: string | null;
  decidedAt: Date | null;
  expiresAt: Date;
  /** The approver has stopped being an owner; their answer no longer counts. */
  void: boolean;
}

export interface OwnerChangeResponse {
  id: string;
  code: string;
  type: string;
  status: string;
  reason: string | null;
  /** Why it ended (cancelled, declined, expired). */
  reviewNote: string | null;
  /** Why it was rejected (a co-owner's reason, or why it could not be applied). */
  rejectReason: string | null;
  proposer: PersonRef & { email: string };
  target: PersonRef | null;
  demoteTo: string | null;
  owners: OwnerCandidateResponse[];
  confirmedCount: number;
  approvals: OwnerChangeApprovalResponse[];
  /** The viewer's own pending / given answer, if they were asked. */
  myApproval: string | null;
  canCancel: boolean;
  createdAt: Date;
  reviewedAt: Date | null;
}

/**
 * Owner changes of an existing organization — add owners, remove another owner. Decided
 * inside the organization, never by a platform admin:
 *
 *   - ADD_OWNER: every proposed person confirms by email, every other owner approves
 *   - REMOVE_OWNER: every owner but the proposer and the target approves
 *
 * The approvers are fixed when the change is created. `OwnerChangeExecutor` applies it as
 * soon as the last condition is met.
 */
export class OwnerChangeService {
  async create(
    organizationId: string,
    actorId: string,
    actorEmail: string,
    input: OwnerChangeInput,
  ): Promise<OwnerChangeResponse> {
    await orgAccessService.assertOrgPermission(
      organizationId,
      actorId,
      OrgPermission.OWNER_PROPOSE,
    );
    const organization = await organizationRepository.findById(organizationId);
    if (!organization) {
      throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Organization not found"));
    }
    const reason = input.reason?.trim().slice(0, 1000) || null;
    // A removed owner stays in the organization as MEMBER unless told otherwise.
    const demoteTo = input.demoteTo ?? OrgMemberRole.MEMBER;
    if (!DEMOTE_ROLES.includes(demoteTo)) {
      throw new HttpError(
        HTTP_STATUS.VALIDATION_ERROR.withMessage("demote_to must be ADMIN or MEMBER"),
      );
    }

    const actor = (await lookupUsersByIds([actorId]).catch(() => new Map())).get(actorId);
    const proposerName: string = actor?.name || actorEmail;
    const ownerIds = await organizationMemberRepository.findOwnerUserIds(organizationId);

    let candidates: { email: string; fullName: string; isLegalRep: boolean }[] = [];
    let targetUserId: string | null = null;
    /** A current owner taking over the legal representative role: not asked to approve. */
    let replacementOwnerId: string | null = null;
    let subjectNames = "";

    switch (input.type) {
      case ApplicationType.ADD_OWNER: {
        await this.assertNoneOpen({ organizationId, type: ApplicationType.ADD_OWNER });
        candidates = await this.resolveNewOwners(organizationId, actorEmail, input.owners ?? []);
        subjectNames = candidates.map((c) => c.fullName).join(", ");
        break;
      }
      case ApplicationType.REMOVE_OWNER: {
        targetUserId = input.targetUserId ?? null;
        if (!targetUserId) {
          throw new HttpError(HTTP_STATUS.VALIDATION_ERROR.withMessage("target_user_id is required"));
        }
        if (!ownerIds.includes(targetUserId)) throw new HttpError(HTTP_STATUS.TARGET_NOT_OWNER);
        const targetRole = await orgAccessService.getRole(organizationId, targetUserId);
        const isLegalRep = targetRole === OrgMemberRole.LEGAL_REPRESENTATIVE;
        // The legal representative is never left vacant: someone must take the role over.
        // That is also the only way to "remove" oneself (the LR stepping down).
        if (isLegalRep && !input.replacement) {
          throw new HttpError(HTTP_STATUS.LEGAL_REP_REPLACEMENT_REQUIRED);
        }
        if (!isLegalRep && input.replacement) {
          throw new HttpError(
            HTTP_STATUS.VALIDATION_ERROR.withMessage(
              "replacement is only for the legal representative",
            ),
          );
        }
        if (targetUserId === actorId && !isLegalRep) {
          throw new HttpError(HTTP_STATUS.CANNOT_TARGET_SELF);
        }
        await this.assertNoneOpen({
          organizationId,
          type: ApplicationType.REMOVE_OWNER,
          targetUserId,
        });
        const target = (await lookupUsersByIds([targetUserId]).catch(() => new Map())).get(
          targetUserId,
        );
        const targetName = target?.name || target?.email || "";
        subjectNames = targetName;
        if (isLegalRep && input.replacement) {
          const resolved = await this.resolveReplacement(
            organizationId,
            actorEmail,
            targetUserId,
            input.replacement,
          );
          candidates = [resolved.candidate];
          replacementOwnerId = resolved.ownerId;
          subjectNames = `${targetName} → ${resolved.candidate.fullName}`;
        }
        break;
      }
      default:
        throw new HttpError(
          HTTP_STATUS.VALIDATION_ERROR.withMessage(
            "type must be ADD_OWNER or REMOVE_OWNER",
          ),
        );
    }

    // Every other owner is asked, except the one being removed and an owner taking over as
    // legal representative (their email confirmation is their answer).
    const approverIds = ownerIds.filter(
      (id) => id !== actorId && id !== targetUserId && id !== replacementOwnerId,
    );
    const now = new Date();
    const expiresAt = new Date(now.getTime() + OWNER_CONFIRM_TTL_DAYS * DAY_MS);
    const profile: OwnerChangeProfile = {
      name: organization.name,
      logoUrl: organization.logoUrl,
      address: organization.address ?? null,
      contactEmail: organization.contactEmail ?? null,
      proposalReason: reason,
      proposerName,
      subjectNames,
    };

    const created = await organizationApplicationService.createWithUniqueCode({
      type: input.type,
      status: OPEN,
      // The plain column, not the `organization` relation: that one is the back-relation of
      // `organizations.application_id` and connecting it would re-point the organization's
      // original application at this change.
      organizationId,
      orgType: organization.orgType,
      submitterEmail: actorEmail.toLowerCase(),
      submittedByUserId: actorId,
      contactEmail: organization.contactEmail,
      targetUserId,
      demoteToRole: input.type === ApplicationType.ADD_OWNER ? null : demoteTo,
      profile: profile as object,
      submittedAt: now,
      consentedAt: now,
      owners: {
        create: candidates.map((c) => ({
          email: c.email,
          fullName: c.fullName,
          isLegalRep: c.isLegalRep,
        })),
      },
      approvals: {
        create: approverIds.map((approverUserId) => ({ approverUserId, expiresAt })),
      },
    });

    const issued: { candidate: CandidateRow; rawToken: string }[] = [];
    const allCandidates = await prisma.$transaction(async (tx) => {
      const rows = await tx.organizationApplicationOwner.findMany({
        where: { applicationId: created.id },
      });
      for (const row of rows) {
        const token = newConfirmToken(now);
        const updated = await tx.organizationApplicationOwner.update({
          where: { id: row.id },
          data: token.data,
        });
        issued.push({ candidate: updated, rawToken: token.raw });
      }
      await organizationApplicationRepository.recordEvent({
        tx,
        applicationId: created.id,
        eventType: ApplicationEventType.SUBMITTED,
        actorId,
        payload: {
          type: input.type,
          organizationId,
          targetUserId,
          demoteTo,
          candidateCount: rows.length,
          approverCount: approverIds.length,
        },
      });
      return rows;
    });

    sendConfirmationEmails({
      issued,
      allOwners: allCandidates,
      submitterEmail: actorEmail,
      orgType: organization.orgType,
      profile,
      // A legal representative's replacement is asked like a new owner.
      isAddOwner: candidates.length > 0,
    });
    const base = ownerChangeExecutor.noticeBase(
      { type: input.type, demoteToRole: demoteTo, profile: profile as object },
      organization,
    );
    notifyApprovalRequested(approverIds, {
      ...base,
      proposerName,
      reason: reason ?? "",
      expiresAt,
    });
    if (input.type === ApplicationType.REMOVE_OWNER && targetUserId) {
      notifyRemovalProposed(targetUserId, {
        ...base,
        proposerName,
        reason: reason ?? "",
        needsApproval: approverIds.length > 0,
      });
    }

    // A removal with nobody left to ask (two owners) takes effect right away.
    await ownerChangeExecutor.tryFinalize(created.id);

    return (await this.buildList(organizationId, actorId)).find((c) => c.id === created.id)!;
  }

  async list(organizationId: string, actorId: string): Promise<OwnerChangeResponse[]> {
    await orgAccessService.assertOrgPermission(
      organizationId,
      actorId,
      OrgPermission.OWNER_PROPOSE,
    );
    return this.buildList(organizationId, actorId);
  }

  /** No permission check: `create` answers with the change it just made even if applying it
   * (or a concurrent change) already cost the proposer their owner role. */
  private async buildList(
    organizationId: string,
    actorId: string,
  ): Promise<OwnerChangeResponse[]> {
    const rows = (await prisma.organizationApplication.findMany({
      where: {
        type: { in: OWNER_CHANGE_TYPE_VALUES },
        organizationId,
        deletedAt: null,
      },
      include: {
        owners: { where: { removedAt: null }, orderBy: { createdAt: "asc" } },
        approvals: { orderBy: { createdAt: "asc" } },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    })) as OwnerChangeRow[];

    const ownerIds = new Set(await organizationMemberRepository.findOwnerUserIds(organizationId));
    const userIds = [
      ...new Set(
        rows.flatMap((row) =>
          [
            row.submittedByUserId,
            row.targetUserId,
            ...row.approvals.map((a) => a.approverUserId),
          ].filter((id): id is string => Boolean(id)),
        ),
      ),
    ];
    // Names are a convenience; an identity outage just leaves them null.
    const people = await lookupUsersByIds(userIds).catch(() => new Map());
    const ref = (userId: string): PersonRef => {
      const person = people.get(userId);
      return { userId, name: person?.name ?? null, avatar: person?.avatar ?? null };
    };

    return rows.map((row) => {
      const profile = (row.profile ?? {}) as OwnerChangeProfile;
      const mine = row.approvals.find((a) => a.approverUserId === actorId);
      return {
        id: row.id,
        code: row.code,
        type: row.type,
        status: row.status,
        reason: profile.proposalReason ?? null,
        reviewNote: row.reviewNote,
        rejectReason: row.rejectReason,
        proposer: {
          ...ref(row.submittedByUserId ?? ""),
          name: people.get(row.submittedByUserId ?? "")?.name ?? profile.proposerName ?? null,
          email: row.submitterEmail,
        },
        target: row.targetUserId ? ref(row.targetUserId) : null,
        demoteTo: row.demoteToRole,
        owners: row.owners.map((o) => toOwnerCandidateResponse(o, row.submitterEmail)),
        confirmedCount: row.owners.filter(
          (o) => o.status === OwnerCandidateStatus.CONFIRMED,
        ).length,
        approvals: row.approvals.map((a) => ({
          ...ref(a.approverUserId),
          status: a.status,
          note: a.note,
          decidedAt: a.decidedAt,
          expiresAt: a.expiresAt,
          void: a.status === OwnerApprovalStatus.PENDING && !ownerIds.has(a.approverUserId),
        })),
        myApproval: mine?.status ?? null,
        canCancel: row.status === OPEN && row.submittedByUserId === actorId,
        createdAt: row.createdAt,
        reviewedAt: row.reviewedAt,
      };
    });
  }

  async approve(organizationId: string, applicationId: string, actorId: string) {
    await this.answer(organizationId, applicationId, actorId, OwnerApprovalStatus.APPROVED, null);
    await ownerChangeExecutor.tryFinalize(applicationId);
  }

  async reject(
    organizationId: string,
    applicationId: string,
    actorId: string,
    note: string | null,
  ) {
    const trimmed = note?.trim().slice(0, 1000) || null;
    await this.answer(
      organizationId,
      applicationId,
      actorId,
      OwnerApprovalStatus.REJECTED,
      trimmed,
    );
    await ownerChangeExecutor.end(applicationId, {
      status: ApplicationStatus.REJECTED,
      reason: trimmed ?? "Một owner đã từ chối.",
      actorId,
    });
  }

  /** Only the proposer cancels; the other owners have "reject". */
  async cancel(organizationId: string, applicationId: string, actorId: string) {
    await orgAccessService.assertOrgPermission(
      organizationId,
      actorId,
      OrgPermission.OWNER_PROPOSE,
    );
    const change = await this.findOwnChange(organizationId, applicationId);
    if (change.status !== OPEN) throw new HttpError(HTTP_STATUS.OWNER_CHANGE_NOT_OPEN);
    if (change.submittedByUserId !== actorId) {
      throw new HttpError(HTTP_STATUS.ORG_PERMISSION_DENIED);
    }
    const ended = await ownerChangeExecutor.end(applicationId, {
      status: ApplicationStatus.WITHDRAWN,
      reason: "Người đề xuất đã huỷ.",
      actorId,
    });
    if (!ended) throw new HttpError(HTTP_STATUS.OWNER_CHANGE_NOT_OPEN);
  }

  async resend(
    organizationId: string,
    applicationId: string,
    candidateId: string,
    actorId: string,
  ): Promise<void> {
    await orgAccessService.assertOrgPermission(
      organizationId,
      actorId,
      OrgPermission.OWNER_PROPOSE,
    );
    await this.findOwnChange(organizationId, applicationId);
    await organizationApplicationService.resendCandidate(applicationId, candidateId);
  }

  private async answer(
    organizationId: string,
    applicationId: string,
    actorId: string,
    status: OwnerApprovalStatus.APPROVED | OwnerApprovalStatus.REJECTED,
    note: string | null,
  ): Promise<void> {
    await orgAccessService.assertOrgPermission(
      organizationId,
      actorId,
      OrgPermission.OWNER_PROPOSE,
    );
    await this.findOwnChange(organizationId, applicationId);
    await prisma.$transaction(async (tx) => {
      await organizationApplicationRepository.lockForUpdate(tx, applicationId);
      const change = await tx.organizationApplication.findUniqueOrThrow({
        where: { id: applicationId },
        include: { approvals: true },
      });
      if (change.status !== OPEN) throw new HttpError(HTTP_STATUS.OWNER_CHANGE_NOT_OPEN);
      const approval = change.approvals.find(
        (a) => a.approverUserId === actorId && a.status === OwnerApprovalStatus.PENDING,
      );
      if (!approval) throw new HttpError(HTTP_STATUS.NOT_PENDING_APPROVER);
      if (approval.expiresAt < new Date()) {
        throw new HttpError(HTTP_STATUS.OWNER_CHANGE_NOT_OPEN);
      }
      await tx.organizationOwnerChangeApproval.update({
        where: { id: approval.id },
        data: { status, note, decidedAt: new Date() },
      });
      await organizationApplicationRepository.recordEvent({
        tx,
        applicationId,
        eventType:
          status === OwnerApprovalStatus.APPROVED
            ? ApplicationEventType.OWNER_CHANGE_APPROVED_BY
            : ApplicationEventType.OWNER_CHANGE_REJECTED_BY,
        actorId,
        payload: { note },
      });
    });
  }

  private async findOwnChange(organizationId: string, applicationId: string) {
    const change = await organizationApplicationRepository.findById(applicationId);
    if (
      !change ||
      !OWNER_CHANGE_TYPE_VALUES.includes(change.type) ||
      change.organizationId !== organizationId
    ) {
      throw new HttpError(HTTP_STATUS.OWNER_CHANGE_NOT_FOUND);
    }
    return change;
  }

  private async assertNoneOpen(where: {
    organizationId: string;
    type: ApplicationType;
    targetUserId?: string;
    submittedByUserId?: string;
  }): Promise<void> {
    const open = await prisma.organizationApplication.findFirst({
      where: { ...where, status: OPEN, deletedAt: null },
      select: { id: true },
    });
    if (open) throw new HttpError(HTTP_STATUS.OWNER_CHANGE_ALREADY_OPEN);
  }

  /**
   * The person taking over as legal representative: a current owner (their role just changes)
   * or anyone else, who must pass the same checks as a new owner (3-organization cap, blocked
   * emails, …).
   */
  private async resolveReplacement(
    organizationId: string,
    actorEmail: string,
    targetUserId: string,
    input: OwnerProposalInput,
  ): Promise<{
    candidate: { email: string; fullName: string; isLegalRep: boolean };
    ownerId: string | null;
  }> {
    const byId = input.userId ? await lookupUsersByIds([input.userId]) : new Map();
    const picked = input.userId ? byId.get(input.userId) : undefined;
    if (input.userId && !picked) throw new HttpError(HTTP_STATUS.INVITEE_NOT_AVAILABLE);
    const [person] = normalizeOwnerInputs([
      {
        email: picked?.email ?? input.email ?? "",
        fullName: input.fullName?.trim() || picked?.name || "",
        isLegalRep: true,
      },
    ]);
    if (!person) throw new HttpError(HTTP_STATUS.AT_LEAST_ONE_OWNER);

    const account = picked ?? (await lookupUsersByEmails([person.email])).get(person.email);
    if (account?.id === targetUserId) {
      throw new HttpError(
        HTTP_STATUS.VALIDATION_ERROR.withMessage(
          "The replacement must be someone other than the legal representative",
        ),
      );
    }
    const role = account ? await orgAccessService.getRole(organizationId, account.id) : null;
    if (isOwnerRole(role)) {
      return {
        candidate: { email: person.email, fullName: person.fullName, isLegalRep: true },
        ownerId: account!.id,
      };
    }
    await organizationApplicationService.assertOwnersEligible(
      "00000000-0000-0000-0000-000000000000",
      actorEmail,
      [person],
    );
    return {
      candidate: { email: person.email, fullName: person.fullName, isLegalRep: true },
      ownerId: null,
    };
  }

  /** ADD_OWNER: picked accounts or typed emails, none of them already an owner. */
  private async resolveNewOwners(
    organizationId: string,
    actorEmail: string,
    inputs: OwnerProposalInput[],
  ) {
    const ids = inputs.map((i) => i.userId).filter((id): id is string => Boolean(id));
    const byId = await lookupUsersByIds(ids);
    const owners = normalizeOwnerInputs(
      inputs.map((input) => {
        const account = input.userId ? byId.get(input.userId) : undefined;
        if (input.userId && !account) {
          throw new HttpError(HTTP_STATUS.INVITEE_NOT_AVAILABLE);
        }
        return {
          email: account?.email ?? input.email ?? "",
          fullName: input.fullName?.trim() || account?.name || "",
          isLegalRep: false,
        };
      }),
    );
    if (owners.length === 0) {
      throw new HttpError(HTTP_STATUS.AT_LEAST_ONE_OWNER);
    }

    const accounts = await lookupUsersByEmails(owners.map((o) => o.email));
    for (const owner of owners) {
      const account = accounts.get(owner.email);
      if (!account) continue;
      const role = await orgAccessService.getRole(organizationId, account.id);
      if (isOwnerRole(role)) {
        throw new HttpError(
          HTTP_STATUS.ALREADY_OWNER.withMessage(
            `${HTTP_STATUS.ALREADY_OWNER.message}: ${owner.email}`,
          ),
        );
      }
    }
    await organizationApplicationService.assertOwnersEligible(
      "00000000-0000-0000-0000-000000000000",
      actorEmail,
      owners,
    );
    return owners.map((o) => ({ email: o.email, fullName: o.fullName, isLegalRep: false }));
  }
}

export const ownerChangeService = new OwnerChangeService();
