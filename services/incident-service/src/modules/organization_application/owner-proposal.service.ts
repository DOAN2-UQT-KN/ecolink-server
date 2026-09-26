import {
  ApplicationEventType,
  ApplicationStatus,
  ApplicationType,
  OrgPermission,
  OwnerCandidateStatus,
  isOwnerRole,
} from "@da2/constants";
import prisma from "../../config/prisma.client";
import { HTTP_STATUS, HttpError } from "../../constants/http-status";
import { orgAccessService } from "../organization/org-access.service";
import { organizationRepository } from "../organization/organization.repository";
import { lookupUsersByEmails, lookupUsersByIds } from "./identity-owner.client";
import { OwnerCandidateResponse } from "./organization-application.dto";
import { enqueueApplicationWithdrawnNoticeEmail } from "./organization-application-notify.client";
import { organizationApplicationRepository } from "./organization-application.repository";
import { organizationApplicationService } from "./organization-application.service";
import {
  CandidateRow,
  newConfirmToken,
  normalizeOwnerInputs,
  sendConfirmationEmails,
  toOwnerCandidateResponse,
} from "./owner-candidates";

/** Statuses in which an ADD_OWNER proposal still occupies the organization's single slot. */
const OPEN_PROPOSAL_STATUSES: string[] = [
  ApplicationStatus.AWAITING_OWNER_CONFIRMATION,
  ApplicationStatus.PENDING_REVIEW,
];

export interface OwnerProposalInput {
  /** An existing account; its email is looked up. */
  userId?: string;
  /** Someone without an account (or an account picked by email). */
  email?: string;
  fullName: string;
}

export interface OwnerProposalResponse {
  id: string;
  code: string;
  status: string;
  reason: string | null;
  /** Why it ended (declined, expired) or the reviewer's rejection reason. */
  reviewNote: string | null;
  rejectReason: string | null;
  submitterEmail: string;
  owners: OwnerCandidateResponse[];
  confirmedCount: number;
  createdAt: Date;
  submittedAt: Date | null;
  reviewedAt: Date | null;
}

interface ProposalProfile {
  name?: string;
  logoUrl?: string;
  address?: string | null;
  contactEmail?: string | null;
  proposalReason?: string | null;
}

/**
 * ADD_OWNER: an owner proposes new owners for their organization. Same guarantees as a new
 * registration — every proposed person confirms by email, then a platform admin reviews —
 * but no profile or documents to fill in. Accounts for people without one are created only
 * at approval, like for a new organization.
 */
export class OwnerProposalService {
  async create(
    organizationId: string,
    actorId: string,
    actorEmail: string,
    inputs: OwnerProposalInput[],
    reason: string | null,
  ): Promise<OwnerProposalResponse> {
    await orgAccessService.assertOrgPermission(
      organizationId,
      actorId,
      OrgPermission.OWNER_PROPOSE,
    );
    const organization = await organizationRepository.findById(organizationId);
    if (!organization) {
      throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Organization not found"));
    }

    const open = await prisma.organizationApplication.findFirst({
      where: {
        type: ApplicationType.ADD_OWNER,
        organizationId,
        status: { in: OPEN_PROPOSAL_STATUSES },
        deletedAt: null,
      },
      select: { id: true },
    });
    if (open) {
      throw new HttpError(HTTP_STATUS.OWNER_PROPOSAL_ALREADY_OPEN);
    }

    // Picked accounts carry an id; resolve their email from identity-service.
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

    // Nobody who already owns this organization.
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

    const profile: ProposalProfile = {
      name: organization.name,
      logoUrl: organization.logoUrl,
      address: organization.address ?? null,
      contactEmail: organization.contactEmail ?? null,
      proposalReason: reason?.trim() || null,
    };
    const now = new Date();

    const created = await organizationApplicationService.createWithUniqueCode({
      type: ApplicationType.ADD_OWNER,
      status: ApplicationStatus.AWAITING_OWNER_CONFIRMATION,
      // The plain column, not the `organization` relation: that one is the back-relation of
      // `organizations.application_id` and connecting it would re-point the organization's
      // original application at this proposal.
      organizationId,
      orgType: organization.orgType,
      submitterEmail: actorEmail.toLowerCase(),
      submittedByUserId: actorId,
      contactEmail: organization.contactEmail,
      profile: profile as object,
      submittedAt: now,
      consentedAt: now,
      owners: {
        create: owners.map((o) => ({
          email: o.email,
          fullName: o.fullName,
          isLegalRep: false,
        })),
      },
    });

    const issued: { candidate: CandidateRow; rawToken: string }[] = [];
    const allOwners = await prisma.$transaction(async (tx) => {
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
          type: ApplicationType.ADD_OWNER,
          organizationId,
          ownerCount: rows.length,
          invitationsSent: rows.length,
        },
      });
      return rows;
    });

    sendConfirmationEmails({
      issued,
      allOwners,
      submitterEmail: actorEmail,
      orgType: organization.orgType,
      profile,
      isAddOwner: true,
    });

    return (await this.list(organizationId, actorId)).find((p) => p.id === created.id)!;
  }

  async list(organizationId: string, actorId: string): Promise<OwnerProposalResponse[]> {
    await orgAccessService.assertOrgPermission(
      organizationId,
      actorId,
      OrgPermission.OWNER_PROPOSE,
    );
    const rows = await prisma.organizationApplication.findMany({
      where: { type: ApplicationType.ADD_OWNER, organizationId, deletedAt: null },
      include: { owners: { where: { removedAt: null }, orderBy: { createdAt: "asc" } } },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return rows.map((row) => {
      const profile = (row.profile ?? {}) as ProposalProfile;
      return {
        id: row.id,
        code: row.code,
        status: row.status,
        reason: profile.proposalReason ?? null,
        reviewNote: row.reviewNote,
        rejectReason: row.rejectReason,
        submitterEmail: row.submitterEmail,
        owners: row.owners.map((o) => toOwnerCandidateResponse(o, row.submitterEmail)),
        confirmedCount: row.owners.filter(
          (o) => o.status === OwnerCandidateStatus.CONFIRMED,
        ).length,
        createdAt: row.createdAt,
        submittedAt: row.submittedAt,
        reviewedAt: row.reviewedAt,
      };
    });
  }

  /** Any owner may cancel an open proposal; people who already confirmed are told. */
  async cancel(organizationId: string, applicationId: string, actorId: string) {
    await orgAccessService.assertOrgPermission(
      organizationId,
      actorId,
      OrgPermission.OWNER_PROPOSE,
    );
    const { confirmed, name, submitterEmail } = await prisma.$transaction(async (tx) => {
      await organizationApplicationRepository.lockForUpdate(tx, applicationId);
      const app = await organizationApplicationRepository.findByIdWithOwners(
        applicationId,
        tx,
      );
      if (
        !app ||
        app.type !== ApplicationType.ADD_OWNER ||
        app.organizationId !== organizationId
      ) {
        throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_NOT_FOUND);
      }
      if (!OPEN_PROPOSAL_STATUSES.includes(app.status)) {
        throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_ALREADY_DECIDED);
      }
      await tx.organizationApplication.update({
        where: { id: app.id },
        data: { status: ApplicationStatus.WITHDRAWN },
      });
      await tx.organizationApplicationOwner.updateMany({
        where: { applicationId: app.id, status: OwnerCandidateStatus.PENDING },
        data: { expiresAt: new Date() },
      });
      await organizationApplicationRepository.recordEvent({
        tx,
        applicationId: app.id,
        eventType: ApplicationEventType.WITHDRAWN,
        actorId,
        payload: { previousStatus: app.status },
      });
      return {
        confirmed: app.owners.filter((o) => o.status === OwnerCandidateStatus.CONFIRMED),
        name: ((app.profile ?? {}) as ProposalProfile).name ?? app.code,
        submitterEmail: app.submitterEmail,
      };
    });

    for (const owner of confirmed) {
      void enqueueApplicationWithdrawnNoticeEmail({
        toEmail: owner.email,
        organizationName: name,
        submitterEmail,
      }).catch((err) => {
        console.warn("[owner-proposal] failed to send a cancellation notice", err);
      });
    }
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
    const app = await organizationApplicationRepository.findById(applicationId);
    if (
      !app ||
      app.type !== ApplicationType.ADD_OWNER ||
      app.organizationId !== organizationId
    ) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_NOT_FOUND);
    }
    await organizationApplicationService.resendCandidate(applicationId, candidateId);
  }
}

export const ownerProposalService = new OwnerProposalService();
