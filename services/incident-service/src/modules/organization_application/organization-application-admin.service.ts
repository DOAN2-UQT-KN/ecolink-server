import { Prisma } from "@prisma/client";
import {
  ApplicationEventType,
  ApplicationLane,
  ApplicationStatus,
  GlobalStatus,
  KycStatus,
  LANE_B_VERIFICATION_VALID_DAYS,
  TrustTier,
  nextUniqueOrganizationSlug,
  slugifyOrganizationName,
} from "@da2/constants";
import prisma from "../../config/prisma.client";
import { HTTP_STATUS, HttpError } from "../../constants/http-status";
import { emitOutbox } from "../../outbox/outbox.writer";
import { OutboxEventType } from "../../outbox/outbox.types";
import {
  ApplicationAdminResponse,
  ApplicationDecisionBody,
  PaginatedApplicationsResponse,
} from "./organization-application.dto";
import {
  fetchOrganizationOwnersByUserIds,
  getUserProfile,
} from "../organization/identity-user.client";
import { organizationApplicationRepository } from "./organization-application.repository";
import {
  enqueueApplicationNeedsInfoEmail,
  enqueueApplicationRejectedEmail,
} from "./organization-application-notify.client";
import { organizationApplicationOtpService } from "./organization-application-otp.service";
import { buildApplicationTrackUrl } from "./organization-application-urls";
import { organizationApplicationService } from "./organization-application.service";
import { documentStorage } from "./storage/cloudinary-document-storage";

type ApplicationRow = Prisma.OrganizationApplicationGetPayload<object>;
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
      orgType: params.orgType,
      lane: params.lane,
      q: params.q,
      skip: (params.page - 1) * params.limit,
      take: params.limit,
    });

    return {
      applications: rows.map((row) =>
        this.toAdminResponse(row, row.documents, []),
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
    if (!application) {
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
    const actors = await fetchOrganizationOwnersByUserIds(actorIds);

    return this.toAdminResponse(
      application,
      application.documents,
      application.events,
      (actorId) => getUserProfile(actors, actorId)?.name ?? null,
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
    const application = await this.loadOpen(applicationId);

    if (
      application.reviewerId &&
      application.reviewerId !== adminUserId &&
      application.status === ApplicationStatus.UNDER_REVIEW
    ) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_CLAIMED);
    }

    await organizationApplicationRepository.update(applicationId, {
      status: ApplicationStatus.UNDER_REVIEW,
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
    const application = await this.loadOpen(applicationId);

    await organizationApplicationRepository.update(applicationId, {
      status: ApplicationStatus.NEEDS_MORE_INFO,
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
      application.contactEmail,
    );
    void enqueueApplicationNeedsInfoEmail({
      toEmail: application.contactEmail,
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

    const application = await this.loadOpen(applicationId);

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

    await organizationApplicationRepository.update(application.id, {
      status: ApplicationStatus.REJECTED,
      reviewerId: adminUserId,
      reviewedAt: new Date(),
      rejectReason: reason,
    });
    await organizationApplicationRepository.recordEvent({
      applicationId: application.id,
      eventType: ApplicationEventType.REJECTED,
      actorId: adminUserId,
      payload: { rejectReason: reason },
    });

    void enqueueApplicationRejectedEmail({
      toEmail: application.contactEmail,
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
   * Step 1 of the provisioning saga, all inside one transaction: the organization, its
   * channels, the application's new status, and the outbox event that will create the ORG
   * login. Writing the event here is what makes the two halves atomic — there is no moment
   * where an organization exists but nothing is scheduled to give it an account.
   */
  private async approve(
    application: ApplicationRow,
    adminUserId: string,
    body: ApplicationDecisionBody,
  ): Promise<ApplicationAdminResponse> {
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

    // Lane A is granted the tick on approval; lane B has to earn it through activity, so it
    // stays at NONE unless the admin explicitly says otherwise.
    const grantBlueTick =
      body.grantBlueTick ?? lane === ApplicationLane.A;
    const now = new Date();
    const slug = await this.allocateSlug(name);

    await prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          name,
          slug,
          description: profile.description ?? null,
          descriptionVi: profile.description ?? null,
          logoUrl,
          backgroundUrl: profile.backgroundUrl ?? null,
          contactEmail: application.contactEmail,
          address: profile.address ?? null,
          // Carried over from the map step so the organization can be placed on a map.
          latitude: profile.latitude ?? null,
          longitude: profile.longitude ?? null,
          // Inherited from the OTP the applicant passed; never verified a second time.
          isEmailVerified: Boolean(application.emailVerifiedAt),
          status: GlobalStatus._STATUS_ACTIVE,
          orgType: application.orgType,
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
          applicationId: application.id,
          // Filled by the provisioning step; the column is nullable for exactly this gap.
          ownerId: null,
          createdBy: adminUserId,
          updatedBy: adminUserId,
        },
      });

      const channels = this.channelsOf(application);
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

      await tx.organizationApplication.update({
        where: { id: application.id },
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
            applicationId: application.id,
            eventType: ApplicationEventType.APPROVED,
            actorId: adminUserId,
            payload: { lane, grantBlueTick, organizationId: organization.id },
          },
          ...(documentsWaived
            ? [
                {
                  applicationId: application.id,
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

      await emitOutbox(tx, {
        aggregateType: "organization_application",
        aggregateId: application.id,
        eventType: OutboxEventType.ORG_ACCOUNT_PROVISION,
        dedupKey: `${OutboxEventType.ORG_ACCOUNT_PROVISION}:${application.id}`,
        payload: {
          applicationId: application.id,
          organizationId: organization.id,
          email: application.contactEmail,
          displayName: name,
          legalRepEmail: application.legalRepEmail,
        },
      });
    });

    return this.getById(application.id);
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  private async loadOpen(applicationId: string): Promise<ApplicationRow> {
    const application =
      await organizationApplicationRepository.findById(applicationId);
    if (!application) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_NOT_FOUND);
    }
    if (
      application.status === ApplicationStatus.APPROVED ||
      application.status === ApplicationStatus.REJECTED ||
      application.status === ApplicationStatus.WITHDRAWN
    ) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_ALREADY_DECIDED);
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

  private channelsOf(application: ApplicationRow): ApplicationChannelShape[] {
    const raw = application.channels;
    return Array.isArray(raw) ? (raw as unknown as ApplicationChannelShape[]) : [];
  }

  private toAdminResponse(
    row: ApplicationRow,
    documents: DocumentRow[],
    events: EventRow[],
    actorNameOf: (actorId: string) => string | null = () => null,
  ): ApplicationAdminResponse {
    return {
      ...organizationApplicationService.toPublicResponse(row, documents),
      lane: row.lane,
      documentsWaived: row.documentsWaived,
      documentsWaivedReason: row.documentsWaivedReason,
      contactEmail: row.contactEmail,
      legalRepresentative: {
        fullName: row.legalRepName,
        idType: row.legalRepIdType,
        // Only the last 4 characters are ever stored, so this is all a reviewer can see.
        idLast4: row.legalRepIdLast4,
        phone: row.legalRepPhone,
        position: row.legalRepPosition,
        email: row.legalRepEmail,
      },
      submittedByUserId: row.submittedByUserId,
      emailVerifiedAt: row.emailVerifiedAt,
      consentedAt: row.consentedAt,
      reviewerId: row.reviewerId,
      claimedAt: row.claimedAt,
      accountProvisionedAt: row.accountProvisionedAt,
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
}

export const organizationApplicationAdminService =
  new OrganizationApplicationAdminService();
