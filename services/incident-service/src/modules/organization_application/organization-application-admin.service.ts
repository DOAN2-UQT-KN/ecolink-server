import { Prisma } from "@prisma/client";
import {
  ApplicationEventType,
  ApplicationLane,
  ApplicationStatus,
  GlobalStatus,
  ApplicationType,
  KycStatus,
  LANE_B_VERIFICATION_VALID_DAYS,
  isOwnerRole,
  MembershipSource,
  OrgMemberRole,
  OwnerCandidateStatus,
  TrustTier,
  nextUniqueOrganizationSlug,
  slugifyOrganizationName,
} from "@da2/constants";
import prisma from "../../config/prisma.client";
import { HTTP_STATUS, HttpError } from "../../constants/http-status";
import { emitOutbox } from "../../outbox/outbox.writer";
import { OutboxEventType } from "../../outbox/outbox.types";
import {
  AdminOwnerCandidateResponse,
  ApplicationAdminResponse,
  ApplicationDecisionBody,
  PaginatedApplicationsResponse,
} from "./organization-application.dto";
import {
  fetchOrganizationOwnersByUserIds,
  getUserProfile,
} from "../organization/identity-user.client";
import { organizationMemberRepository } from "../organization/organization_member.repository";
import { organizationMembershipService } from "../organization/organization-membership.service";
import {
  HIDDEN_FROM_ADMIN_STATUSES,
  organizationApplicationRepository,
} from "./organization-application.repository";
import {
  IdentityUserStatus,
  IdentityUserSummary,
  ensureUsers,
  lookupUsersByEmails,
} from "./identity-owner.client";
import { CandidateRow, toOwnerCandidateResponse } from "./owner-candidates";
import {
  enqueueApplicationNeedsInfoEmail,
  enqueueApplicationRejectedEmail,
} from "./organization-application-notify.client";
import { organizationApplicationOtpService } from "./organization-application-otp.service";
import { buildApplicationTrackUrl } from "./organization-application-urls";
import { organizationApplicationService } from "./organization-application.service";
import { documentStorage } from "./storage/cloudinary-document-storage";

type ApplicationRow = Prisma.OrganizationApplicationGetPayload<object>;

/** Two confirmations from one IP within this window are flagged for the reviewer. */
const SAME_IP_WINDOW_MS = 5 * 60 * 1000;
type DocumentRow = Prisma.OrganizationApplicationDocumentGetPayload<object>;
type EventRow = Prisma.OrganizationApplicationEventGetPayload<object>;

interface ApplicationProfileShape {
  name?: string;
  contactEmail?: string;
  logoUrl?: string;
  backgroundUrl?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  description?: string | null;
}

interface ApplicationChannelShape {
  type: string;
  url: string;
  isPrimary?: boolean;
}

export class OrganizationApplicationAdminService {
  /* ------------------------------------------------------------------ */
  /* Reading                                                             */
  /* ------------------------------------------------------------------ */

  async list(params: {
    status?: string[];
    orgType?: string[];
    lane?: string[];
    q?: string;
    page: number;
    limit: number;
  }): Promise<PaginatedApplicationsResponse> {
    const { rows, total } = await organizationApplicationRepository.search({
      status: params.status,
      // Nothing reaches the queue before every owner has confirmed.
      excludeStatus: HIDDEN_FROM_ADMIN_STATUSES,
      orgType: params.orgType,
      lane: params.lane,
      q: params.q,
      skip: (params.page - 1) * params.limit,
      take: params.limit,
    });

    return {
      applications: rows.map((row) =>
        this.toAdminResponse(row, row.documents, [], row.owners),
      ),
      total,
      page: params.page,
      limit: params.limit,
      totalPages: Math.max(1, Math.ceil(total / params.limit)),
    };
  }

  async getById(id: string): Promise<ApplicationAdminResponse> {
    const application =
      await organizationApplicationRepository.findByIdWithRelations(id);
    if (
      !application ||
      HIDDEN_FROM_ADMIN_STATUSES.includes(application.status)
    ) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_NOT_FOUND);
    }
    // Names are a convenience for the activity log; an identity outage just leaves them null.
    const actorIds = [
      ...new Set(
        application.events
          .map((event) => event.actorId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const [actors, accounts] = await Promise.all([
      fetchOrganizationOwnersByUserIds(actorIds),
      lookupUsersByEmails(application.owners.map((o) => o.email)).catch(
        (error) => {
          console.warn(
            "[organization-application] identity lookup failed; owner accounts left blank",
            error,
          );
          return new Map<string, IdentityUserSummary>();
        },
      ),
    ]);
    const ownerOrgCounts = await organizationMemberRepository.countActiveOwnerOrgs(
      [...accounts.values()].map((u) => u.id),
    );

    return this.toAdminResponse(
      application,
      application.documents,
      application.events,
      application.owners,
      (actorId) => getUserProfile(actors, actorId)?.name ?? null,
      { accounts, ownerOrgCounts },
    );
  }

  /**
   * Streams one document to the reviewer. The file never gets a URL of its own — the signed
   * provider link is minted server-side and thrown away — and every view is written to the
   * audit trail.
   */
  async openDocument(
    applicationId: string,
    documentId: string,
    adminUserId: string,
  ) {
    const document =
      await organizationApplicationRepository.findDocumentById(documentId);
    if (!document || document.applicationId !== applicationId) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_DOCUMENT_NOT_FOUND);
    }
    if (document.purgedAt) {
      throw new HttpError(
        HTTP_STATUS.ORGANIZATION_DOCUMENT_NOT_FOUND.withMessage(
          "This document has been erased by the retention policy",
        ),
      );
    }

    await organizationApplicationRepository.recordEvent({
      applicationId,
      eventType: ApplicationEventType.DOCUMENT_VIEWED,
      actorId: adminUserId,
      payload: { documentId, docType: document.docType },
    });

    const download = await documentStorage.download(
      document.storageKey,
      document.format,
    );
    return { ...download, fileName: document.fileName ?? documentId };
  }

  /* ------------------------------------------------------------------ */
  /* Review actions                                                      */
  /* ------------------------------------------------------------------ */

  /** Takes the file so two reviewers do not work on it at the same time. */
  async claim(
    applicationId: string,
    adminUserId: string,
  ): Promise<ApplicationAdminResponse> {
    const application = await this.loadPendingReview(applicationId);

    if (application.reviewerId && application.reviewerId !== adminUserId) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_CLAIMED);
    }

    // Claiming no longer changes the status: PENDING_REVIEW is the whole review stage.
    await organizationApplicationRepository.update(applicationId, {
      reviewerId: adminUserId,
      claimedAt: new Date(),
    });
    await organizationApplicationRepository.recordEvent({
      applicationId,
      eventType: ApplicationEventType.CLAIMED,
      actorId: adminUserId,
    });

    return this.getById(applicationId);
  }

  /**
   * Sends the file back to the applicant with a note. This is the state that keeps most club
   * applications alive — without it a reviewer could only reject, and the applicant would
   * have to start over.
   */
  async requestMoreInfo(
    applicationId: string,
    adminUserId: string,
    message: string,
  ): Promise<ApplicationAdminResponse> {
    const application = await this.loadPendingReview(applicationId);
    if (application.type === ApplicationType.ADD_OWNER) {
      // An owner proposal has nothing to edit; approve it or reject it with a reason.
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage(
          "An owner proposal cannot be sent back for changes; approve or reject it",
        ),
      );
    }

    await organizationApplicationRepository.update(applicationId, {
      status: ApplicationStatus.NEEDS_REVISION,
      reviewerId: adminUserId,
      reviewNote: message,
    });
    await organizationApplicationRepository.recordEvent({
      applicationId,
      eventType: ApplicationEventType.INFO_REQUESTED,
      actorId: adminUserId,
      payload: { message },
    });

    const tracking = await organizationApplicationOtpService.issueTrackingToken(
      application.submitterEmail,
    );
    void enqueueApplicationNeedsInfoEmail({
      toEmail: application.submitterEmail,
      organizationName: this.profileOf(application).name ?? application.code,
      applicationCode: application.code,
      message,
      trackUrl: buildApplicationTrackUrl(applicationId, tracking.token),
    }).catch((err) => {
      console.warn(
        "[organization-application] failed to send the request-info email",
        err,
      );
    });

    return this.getById(applicationId);
  }

  async decide(
    applicationId: string,
    adminUserId: string,
    body: ApplicationDecisionBody,
  ): Promise<ApplicationAdminResponse> {
    const decision = body.decision?.toUpperCase();
    if (decision !== "APPROVE" && decision !== "REJECT") {
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage(
          "decision must be APPROVE or REJECT",
        ),
      );
    }

    const application = await this.loadPendingReview(applicationId);

    if (decision === "REJECT") {
      return this.reject(application, adminUserId, body);
    }
    return this.approve(application, adminUserId, body);
  }

  private async reject(
    application: ApplicationRow,
    adminUserId: string,
    body: ApplicationDecisionBody,
  ): Promise<ApplicationAdminResponse> {
    const reason = body.rejectReason?.trim();
    if (!reason) {
      throw new HttpError(
        HTTP_STATUS.VALIDATION_ERROR.withMessage(
          "reject_reason is required when rejecting an application",
        ),
      );
    }

    await prisma.$transaction(async (tx) => {
      await organizationApplicationRepository.lockForUpdate(tx, application.id);
      const fresh = await tx.organizationApplication.findUniqueOrThrow({
        where: { id: application.id },
        select: { status: true },
      });
      if (fresh.status !== ApplicationStatus.PENDING_REVIEW) {
        throw new HttpError(HTTP_STATUS.NOT_PENDING_REVIEW);
      }
      await tx.organizationApplication.update({
        where: { id: application.id },
        data: {
          status: ApplicationStatus.REJECTED,
          reviewerId: adminUserId,
          reviewedAt: new Date(),
          rejectReason: reason,
        },
      });
    });
    await organizationApplicationRepository.recordEvent({
      applicationId: application.id,
      eventType: ApplicationEventType.REJECTED,
      actorId: adminUserId,
      payload: { rejectReason: reason },
    });

    void enqueueApplicationRejectedEmail({
      toEmail: application.submitterEmail,
      organizationName: this.profileOf(application).name ?? application.code,
      applicationCode: application.code,
      rejectReason: reason,
    }).catch((err) => {
      console.warn(
        "[organization-application] failed to send the rejection email",
        err,
      );
    });

    return this.getById(application.id);
  }

  /**
   * Creates the organization and makes every confirmed candidate an owner, in one
   * transaction:
   *
   *   1. identity-service finds or creates a person account per candidate (outside the
   *      transaction; idempotent, so a failed approval only leaves unactivated accounts
   *      that the next attempt reuses)
   *   2. lock the application, re-check PENDING_REVIEW and that every owner confirmed —
   *      the state machine already guarantees it; this is defence in depth
   *   3. organization + channels
   *   4. per candidate: 3-org cap under a per-user lock, then the membership
   *   5. one outbox event per candidate for the activation / "you were added" email
   */
  /**
   * ADD_OWNER: no organization to create, no lane or documents. Every confirmed person gets
   * an OWNER membership (a MEMBER / ADMIN / … is upgraded), under the same 3-organization
   * cap and per-user lock as a new organization, and the same onboarding email.
   */
  private async approveAddOwner(
    application: ApplicationRow,
    adminUserId: string,
  ): Promise<ApplicationAdminResponse> {
    const organizationId = application.organizationId;
    const organization = organizationId
      ? await prisma.organization.findUnique({ where: { id: organizationId } })
      : null;
    if (!organizationId || !organization || organization.deletedAt) {
      throw new HttpError(
        HTTP_STATUS.CONFLICT.withMessage("The organization of this proposal no longer exists"),
      );
    }

    const withOwners = await organizationApplicationRepository.findByIdWithOwners(
      application.id,
    );
    const candidates = withOwners?.owners ?? [];
    if (candidates.length === 0) {
      throw new HttpError(HTTP_STATUS.AT_LEAST_ONE_OWNER);
    }

    let users: Map<string, IdentityUserSummary>;
    try {
      users = await ensureUsers(
        candidates.map((c) => ({ email: c.email, fullName: c.fullName })),
      );
    } catch (error) {
      console.error("[organization-application] ensure-users failed", error);
      throw new HttpError(
        HTTP_STATUS.SERVICE_UNAVAILABLE.withMessage(
          "Could not prepare the owners' accounts, please try again",
        ),
      );
    }
    for (const candidate of candidates) {
      const user = users.get(candidate.email);
      if (!user) {
        throw new HttpError(
          HTTP_STATUS.SERVICE_UNAVAILABLE.withMessage(
            `Identity service returned no account for ${candidate.email}`,
          ),
        );
      }
      if (user.status === IdentityUserStatus.INACTIVE) {
        throw new HttpError(
          HTTP_STATUS.OWNER_SUSPENDED.withMessage(
            `${HTTP_STATUS.OWNER_SUSPENDED.message}: ${candidate.email}`,
          ),
        );
      }
    }

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await organizationApplicationRepository.lockForUpdate(tx, application.id);
      const fresh = await organizationApplicationRepository.findByIdWithOwners(
        application.id,
        tx,
      );
      if (!fresh || fresh.status !== ApplicationStatus.PENDING_REVIEW) {
        throw new HttpError(HTTP_STATUS.NOT_PENDING_REVIEW);
      }
      if (
        fresh.owners.length === 0 ||
        fresh.owners.some((o) => o.status !== OwnerCandidateStatus.CONFIRMED)
      ) {
        throw new HttpError(HTTP_STATUS.OWNERS_NOT_ALL_CONFIRMED);
      }

      const granted: string[] = [];
      for (const candidate of fresh.owners) {
        const user = users.get(candidate.email)!;
        const current = await tx.organizationMember.findFirst({
          where: { organizationId, userId: user.id, deletedAt: null },
          select: { role: true },
        });
        // Became an owner some other way meanwhile: nothing to grant.
        if (!isOwnerRole(current?.role)) {
          await organizationMembershipService.assertOwnerQuota(tx, user.id, candidate.email);
          await organizationMembershipService.grantMembership(tx, {
            userId: user.id,
            organizationId,
            role: OrgMemberRole.OWNER,
            source: MembershipSource.APPLICATION_APPROVAL,
            sourceRef: fresh.id,
            actorId: adminUserId,
          });
          granted.push(user.id);
        }
        await tx.organizationApplicationOwner.update({
          where: { id: candidate.id },
          data: { resolvedUserId: user.id },
        });
        await emitOutbox(tx, {
          aggregateType: "organization_application",
          aggregateId: fresh.id,
          eventType: OutboxEventType.ORG_OWNER_ONBOARD,
          dedupKey: `${OutboxEventType.ORG_OWNER_ONBOARD}:${candidate.id}`,
          payload: {
            applicationId: fresh.id,
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

      await tx.organizationApplication.update({
        where: { id: fresh.id },
        data: {
          status: ApplicationStatus.APPROVED,
          reviewerId: adminUserId,
          reviewedAt: now,
          rejectReason: null,
        },
      });
      await tx.organizationApplicationEvent.create({
        data: {
          applicationId: fresh.id,
          eventType: ApplicationEventType.APPROVED,
          actorId: adminUserId,
          payload: {
            type: ApplicationType.ADD_OWNER,
            organizationId,
            ownerUserIds: granted,
          },
        },
      });
    });

    return this.getById(application.id);
  }

  private async approve(
    application: ApplicationRow,
    adminUserId: string,
    body: ApplicationDecisionBody,
  ): Promise<ApplicationAdminResponse> {
    if (application.type === ApplicationType.ADD_OWNER) {
      return this.approveAddOwner(application, adminUserId);
    }
    const lane = (body.lane ?? "").toUpperCase();
    if (lane !== ApplicationLane.A && lane !== ApplicationLane.B) {
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage(
          "lane must be A or B when approving",
        ),
      );
    }

    const documentsWaived = Boolean(body.documentsWaived);
    const waivedReason = body.documentsWaivedReason?.trim() ?? "";
    if (documentsWaived && !waivedReason) {
      throw new HttpError(
        HTTP_STATUS.VALIDATION_ERROR.withMessage(
          "documents_waived_reason is required when waiving the document requirement",
        ),
      );
    }

    const documentCount =
      await organizationApplicationRepository.countDocumentsForApplication(
        application.id,
      );
    if (!documentsWaived && documentCount === 0) {
      throw new HttpError(
        HTTP_STATUS.VALIDATION_ERROR.withMessage(
          "This application has no documents; waive the requirement explicitly to approve it",
        ),
      );
    }

    const profile = this.profileOf(application);
    const name = profile.name?.trim();
    const logoUrl = profile.logoUrl?.trim();
    if (!name || !logoUrl) {
      throw new HttpError(
        HTTP_STATUS.VALIDATION_ERROR.withMessage(
          "The application profile is missing a name or logo",
        ),
      );
    }

    const withOwners = await organizationApplicationRepository.findByIdWithOwners(
      application.id,
    );
    const candidates = withOwners?.owners ?? [];
    if (candidates.length === 0) {
      throw new HttpError(HTTP_STATUS.AT_LEAST_ONE_OWNER);
    }

    let users: Map<string, IdentityUserSummary>;
    try {
      users = await ensureUsers(
        candidates.map((c) => ({ email: c.email, fullName: c.fullName })),
      );
    } catch (error) {
      console.error("[organization-application] ensure-users failed", error);
      throw new HttpError(
        HTTP_STATUS.SERVICE_UNAVAILABLE.withMessage(
          "Could not prepare the owners' accounts, please try again",
        ),
      );
    }
    for (const candidate of candidates) {
      const user = users.get(candidate.email);
      if (!user) {
        throw new HttpError(
          HTTP_STATUS.SERVICE_UNAVAILABLE.withMessage(
            `Identity service returned no account for ${candidate.email}`,
          ),
        );
      }
      if (user.status === IdentityUserStatus.INACTIVE) {
        throw new HttpError(
          HTTP_STATUS.OWNER_SUSPENDED.withMessage(
            `${HTTP_STATUS.OWNER_SUSPENDED.message}: ${candidate.email}`,
          ),
        );
      }
    }

    // Lane A is granted the tick on approval; lane B has to earn it through activity, so it
    // stays at NONE unless the admin explicitly says otherwise.
    const grantBlueTick =
      body.grantBlueTick ?? lane === ApplicationLane.A;
    const now = new Date();
    const slug = await this.allocateSlug(name);

    await prisma.$transaction(async (tx) => {
      await organizationApplicationRepository.lockForUpdate(tx, application.id);
      const fresh = await organizationApplicationRepository.findByIdWithOwners(
        application.id,
        tx,
      );
      if (!fresh || fresh.status !== ApplicationStatus.PENDING_REVIEW) {
        throw new HttpError(HTTP_STATUS.NOT_PENDING_REVIEW);
      }
      if (
        fresh.owners.length === 0 ||
        fresh.owners.some((o) => o.status !== OwnerCandidateStatus.CONFIRMED)
      ) {
        throw new HttpError(HTTP_STATUS.OWNERS_NOT_ALL_CONFIRMED);
      }

      const contactEmail = fresh.contactEmail ?? fresh.submitterEmail;
      const organization = await tx.organization.create({
        data: {
          name,
          slug,
          description: profile.description ?? null,
          descriptionVi: profile.description ?? null,
          logoUrl,
          backgroundUrl: profile.backgroundUrl ?? null,
          contactEmail,
          address: profile.address ?? null,
          // Carried over from the map step so the organization can be placed on a map.
          latitude: profile.latitude ?? null,
          longitude: profile.longitude ?? null,
          // The OTP proved the submitter's mailbox; that only counts when the organization's
          // contact address is that same mailbox.
          isEmailVerified:
            Boolean(fresh.emailVerifiedAt) && contactEmail === fresh.submitterEmail,
          status: GlobalStatus._STATUS_ACTIVE,
          orgType: fresh.orgType,
          kycStatus: KycStatus.APPROVED,
          trustTier: grantBlueTick ? TrustTier.VERIFIED : TrustTier.NONE,
          domainVerified: lane === ApplicationLane.A && documentsWaived,
          verifiedAt: now,
          verifiedBy: adminUserId,
          verificationExpiresAt:
            lane === ApplicationLane.B
              ? new Date(
                  now.getTime() +
                    LANE_B_VERIFICATION_VALID_DAYS * 24 * 60 * 60 * 1000,
                )
              : null,
          applicationId: fresh.id,
          createdBy: adminUserId,
          updatedBy: adminUserId,
        },
      });

      const channels = this.channelsOf(fresh);
      if (channels.length) {
        await tx.organizationChannel.createMany({
          data: channels.map((channel) => ({
            organizationId: organization.id,
            type: channel.type,
            url: channel.url,
            isPrimary: Boolean(channel.isPrimary),
            createdBy: adminUserId,
          })),
        });
      }

      for (const candidate of fresh.owners) {
        const user = users.get(candidate.email)!;
        await organizationMembershipService.assertOwnerQuota(
          tx,
          user.id,
          candidate.email,
        );
        await organizationMembershipService.grantMembership(tx, {
          userId: user.id,
          organizationId: organization.id,
          role: candidate.isLegalRep
            ? OrgMemberRole.LEGAL_REPRESENTATIVE
            : OrgMemberRole.OWNER,
          source: MembershipSource.APPLICATION_APPROVAL,
          sourceRef: fresh.id,
          actorId: adminUserId,
        });
        await tx.organizationApplicationOwner.update({
          where: { id: candidate.id },
          data: { resolvedUserId: user.id },
        });
        await emitOutbox(tx, {
          aggregateType: "organization_application",
          aggregateId: fresh.id,
          eventType: OutboxEventType.ORG_OWNER_ONBOARD,
          dedupKey: `${OutboxEventType.ORG_OWNER_ONBOARD}:${candidate.id}`,
          payload: {
            applicationId: fresh.id,
            candidateId: candidate.id,
            organizationId: organization.id,
            organizationName: name,
            organizationSlug: slug,
            userId: user.id,
            email: candidate.email,
            fullName: candidate.fullName,
            isLegalRep: candidate.isLegalRep,
          },
        });
      }

      await tx.organizationApplication.update({
        where: { id: fresh.id },
        data: {
          status: ApplicationStatus.APPROVED,
          lane,
          documentsWaived,
          documentsWaivedReason: documentsWaived ? waivedReason : null,
          reviewerId: adminUserId,
          reviewedAt: now,
          rejectReason: null,
          organizationId: organization.id,
        },
      });

      await tx.organizationApplicationEvent.createMany({
        data: [
          {
            applicationId: fresh.id,
            eventType: ApplicationEventType.APPROVED,
            actorId: adminUserId,
            payload: {
              lane,
              grantBlueTick,
              organizationId: organization.id,
              ownerUserIds: fresh.owners.map((c) => users.get(c.email)!.id),
            },
          },
          ...(documentsWaived
            ? [
                {
                  applicationId: fresh.id,
                  eventType: ApplicationEventType.DOCUMENTS_WAIVED,
                  actorId: adminUserId,
                  // Who waived what and why is the only control left once the automatic
                  // rules are gone, so it is written next to the approval itself.
                  payload: { reason: waivedReason, lane },
                },
              ]
            : []),
        ],
      });
    });

    return this.getById(application.id);
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  /** Review actions only apply to applications in the queue. */
  private async loadPendingReview(
    applicationId: string,
  ): Promise<ApplicationRow> {
    const application =
      await organizationApplicationRepository.findById(applicationId);
    if (
      !application ||
      HIDDEN_FROM_ADMIN_STATUSES.includes(application.status)
    ) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_NOT_FOUND);
    }
    if (
      application.status === ApplicationStatus.APPROVED ||
      application.status === ApplicationStatus.REJECTED ||
      application.status === ApplicationStatus.WITHDRAWN
    ) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_ALREADY_DECIDED);
    }
    if (application.status !== ApplicationStatus.PENDING_REVIEW) {
      throw new HttpError(HTTP_STATUS.NOT_PENDING_REVIEW);
    }
    return application;
  }

  /** Same slug rules as the legacy create path, so URLs stay consistent. */
  private async allocateSlug(name: string): Promise<string> {
    const base = slugifyOrganizationName(name);
    const taken = await prisma.organization.findMany({
      where: { OR: [{ slug: base }, { slug: { startsWith: `${base}-` } }] },
      select: { slug: true },
    });
    try {
      return nextUniqueOrganizationSlug(base, new Set(taken.map((t) => t.slug)));
    } catch {
      throw new HttpError(
        HTTP_STATUS.CONFLICT.withMessage("Unable to allocate a unique slug"),
      );
    }
  }

  private profileOf(application: ApplicationRow): ApplicationProfileShape {
    return (application.profile ?? {}) as ApplicationProfileShape;
  }

  private channelsOf(
    application: Pick<ApplicationRow, "channels">,
  ): ApplicationChannelShape[] {
    const raw = application.channels;
    return Array.isArray(raw) ? (raw as unknown as ApplicationChannelShape[]) : [];
  }

  private toAdminResponse(
    row: ApplicationRow,
    documents: DocumentRow[],
    events: EventRow[],
    owners: CandidateRow[],
    actorNameOf: (actorId: string) => string | null = () => null,
    evidence: {
      accounts: Map<string, IdentityUserSummary>;
      ownerOrgCounts: Map<string, number>;
    } = { accounts: new Map(), ownerOrgCounts: new Map() },
  ): ApplicationAdminResponse {
    const base = organizationApplicationService.toPublicResponse(
      row,
      documents,
      owners,
    );
    return {
      ...base,
      owners: owners.map((owner) =>
        this.toAdminOwner(owner, owners, row.submitterEmail, evidence),
      ),
      lane: row.lane,
      documentsWaived: row.documentsWaived,
      documentsWaivedReason: row.documentsWaivedReason,
      submittedByUserId: row.submittedByUserId,
      emailVerifiedAt: row.emailVerifiedAt,
      reviewerId: row.reviewerId,
      claimedAt: row.claimedAt,
      purgedAt: row.purgedAt,
      events: events.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        actorId: event.actorId,
        actorName: event.actorId ? actorNameOf(event.actorId) : null,
        payload: event.payload,
        createdAt: event.createdAt,
      })),
    };
  }

  /**
   * The reviewer checks the people, not just the paperwork. Two signals matter most: how
   * close each person is to the 3-organization cap, and confirmations from the same IP within
   * minutes of each other (people registering together — or one person filling in for all).
   */
  private toAdminOwner(
    owner: CandidateRow,
    all: CandidateRow[],
    submitterEmail: string,
    evidence: {
      accounts: Map<string, IdentityUserSummary>;
      ownerOrgCounts: Map<string, number>;
    },
  ): AdminOwnerCandidateResponse {
    const account = evidence.accounts.get(owner.email) ?? null;
    const sameIpCluster =
      !!owner.confirmIp &&
      !!owner.respondedAt &&
      all.some(
        (other) =>
          other.id !== owner.id &&
          other.confirmIp === owner.confirmIp &&
          !!other.respondedAt &&
          Math.abs(
            other.respondedAt.getTime() - owner.respondedAt!.getTime(),
          ) <= SAME_IP_WINDOW_MS,
      );
    return {
      ...toOwnerCandidateResponse(owner, submitterEmail),
      confirmIp: owner.confirmIp,
      confirmUa: owner.confirmUa,
      resolvedUserId: owner.resolvedUserId,
      account: account
        ? { userId: account.id, status: account.status, createdAt: account.createdAt }
        : null,
      activeOwnerOrgCount: account
        ? (evidence.ownerOrgCounts.get(account.id) ?? 0)
        : 0,
      sameIpCluster,
    };
  }
}

export const organizationApplicationAdminService =
  new OrganizationApplicationAdminService();
