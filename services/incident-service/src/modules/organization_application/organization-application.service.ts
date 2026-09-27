import { Prisma } from "@prisma/client";
import { randomBytes } from "crypto";
import {
  APPLICATION_DOCUMENT_LIMITS,
  ApplicationDocType,
  DRAFT_UPDATE_NOTICE_COOLDOWN_MS,
  ApplicationEventType,
  ApplicationStatus,
  ApplicationType,
  EDITABLE_APPLICATION_STATUSES,
  LegalRepIdType,
  MAX_PENDING_INVITES_PER_EMAIL,
  OWNER_ORG_LIMIT,
  OrgType,
  OrganizationChannelType,
  OwnerCandidateStatus,
  isOpenApplicationStatus,
} from "@da2/constants";
import prisma from "../../config/prisma.client";
import {
  HTTP_STATUS,
  HttpError,
  HttpStatusResponse,
} from "../../constants/http-status";
import { hashOpaqueToken } from "../../utils/token-hash";
import { organizationMemberRepository } from "../organization/organization_member.repository";
import {
  ApplicationChannelInput,
  ApplicationDocumentResponse,
  ApplicationProfileInput,
  ApplicationPublicResponse,
  ConfirmationRequestMeta,
  LegalRepresentativeInput,
  LegalRepresentativeResponse,
  PresignApplicationDocumentResponse,
  SaveApplicationBody,
  SubmitApplicationBody,
} from "./organization-application.dto";
import { organizationApplicationRepository } from "./organization-application.repository";
import { organizationApplicationOtpService } from "./organization-application-otp.service";
import {
  enqueueApplicationDraftStartedEmail,
  enqueueApplicationDraftUpdatedEmail,
  enqueueApplicationReceivedEmail,
  enqueueApplicationWithdrawnNoticeEmail,
} from "./organization-application-notify.client";
import {
  buildApplicationEditUrl,
  buildApplicationTrackUrl,
} from "./organization-application-urls";
import {
  IdentityUserStatus,
  lookupUsersByEmails,
} from "./identity-owner.client";
import {
  CandidateRow,
  buildConfirmationSnapshot,
  fingerprint,
  newConfirmToken,
  nextResendAt,
  normalizeEmail,
  normalizeOwnerInputs,
  sendConfirmationEmails,
  snapshotsDiffer,
  toOwnerCandidateResponse,
  validateOwnerList,
} from "./owner-candidates";
import { documentStorage } from "./storage/cloudinary-document-storage";

type DocumentRow = {
  id: string;
  docType: string;
  fileName: string | null;
  mimeType: string;
  sizeBytes: number;
  purgedAt: Date | null;
  createdAt: Date;
};

type ApplicationRow = Prisma.OrganizationApplicationGetPayload<object>;

const MIME_TO_FORMAT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

function isOneOf(value: string, allowed: Record<string, string>): boolean {
  return Object.values(allowed).includes(value);
}

function isEditable(status: string): boolean {
  return (EDITABLE_APPLICATION_STATUSES as readonly string[]).includes(status);
}

/**
 * Fields whose edits are worth telling a reviewer about on resubmission. Only fingerprints
 * are stored, so the activity log never becomes a second copy of the personal data.
 */
const TRACKED_FIELDS = [
  "orgType",
  "profile.name",
  "profile.description",
  "profile.address",
  "profile.logoUrl",
  "profile.backgroundUrl",
  "profile.contactEmail",
  "profile.location",
  "channels",
  "legalRepresentative",
  "owners",
] as const;

function withEmailDetails(
  status: HttpStatusResponse,
  email: string,
): HttpError {
  return new HttpError(status.withMessage(`${status.message}: ${email}`));
}

export class OrganizationApplicationService {
  /* ------------------------------------------------------------------ */
  /* Step 1 — open the draft                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Called once the OTP passed. Hands back the mailbox's open application if it has one (so a
   * second OTP resumes rather than duplicates), otherwise creates a draft with the submitter
   * already on the owner list. The tracking link is issued now, not at submission: collecting
   * several owners' details can take days, and the draft must survive that.
   */
  async openDraftForEmail(rawEmail: string): Promise<{
    applicationId: string;
    trackingToken: string;
    resumed: boolean;
  }> {
    const email = normalizeEmail(rawEmail);
    const existing =
      await organizationApplicationRepository.findOpenBySubmitterEmail(email);

    let applicationId: string;
    let applicationCode: string;
    let resumed = false;
    if (existing) {
      applicationId = existing.id;
      applicationCode = existing.code;
      resumed = true;
    } else {
      const now = new Date();
      const created = await this.createWithUniqueCode({
        type: ApplicationType.NEW_ORG,
        status: ApplicationStatus.DRAFT,
        submitterEmail: email,
        contactEmail: email,
        profile: { contactEmail: email },
        emailVerifiedAt: now,
        owners: {
          create: [{ email, fullName: email.split("@")[0], isLegalRep: true }],
        },
      });
      applicationId = created.id;
      applicationCode = created.code;
    }

    const tracking =
      await organizationApplicationOtpService.issueTrackingToken(email);

    // Only a new draft gets the email: on resume the applicant already holds a link, and
    // re-entering the code must not become a way to flood the inbox. A failed send never
    // blocks the draft — the same code step can always reopen it.
    if (!resumed) {
      void enqueueApplicationDraftStartedEmail({
        toEmail: email,
        applicationCode,
        editUrl: buildApplicationEditUrl(applicationId, tracking.token),
        expiresInDays: Math.round(
          (tracking.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
        ),
      }).catch((err) => {
        console.warn(
          "[organization-application] failed to send the draft link email",
          err,
        );
      });
    }

    return { applicationId, trackingToken: tracking.token, resumed };
  }

  /* ------------------------------------------------------------------ */
  /* Documents                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Hands the browser short-lived, signed parameters so it can upload one file straight to
   * private storage. The row is created detached; the next draft save attaches it after
   * checking it came from this mailbox.
   */
  async presignDocumentForApplication(
    applicationId: string,
    trackingToken: string,
    input: {
      docType: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
    },
  ): Promise<PresignApplicationDocumentResponse> {
    const application = await this.loadForApplicant(applicationId, trackingToken);
    if (!isEditable(application.status)) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_NOT_EDITABLE);
    }
    const email = application.submitterEmail;

    if (!isOneOf(input.docType, ApplicationDocType)) {
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage("Unknown document type"),
      );
    }

    const format = MIME_TO_FORMAT[input.mimeType];
    if (!format) {
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage(
          `Only ${APPLICATION_DOCUMENT_LIMITS.allowedMimeTypes.join(", ")} are accepted`,
        ),
      );
    }

    if (input.sizeBytes > APPLICATION_DOCUMENT_LIMITS.maxFileSizeBytes) {
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage(
          `Each file must be at most ${APPLICATION_DOCUMENT_LIMITS.maxFileSizeBytes / (1024 * 1024)} MB`,
        ),
      );
    }

    const pending =
      await organizationApplicationRepository.countUnattachedDocuments(email);
    if (pending >= APPLICATION_DOCUMENT_LIMITS.maxFilesPerApplication) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_DOCUMENT_LIMIT);
    }

    const signed = documentStorage.createSignedUpload({
      scopeId: hashOpaqueToken(email).slice(0, 16),
      docType: input.docType,
      format,
    });

    const document = await organizationApplicationRepository.createDocument({
      submissionEmail: email,
      docType: input.docType,
      storageKey: signed.storageKey,
      format,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      fileName: input.fileName,
    });

    return {
      documentId: document.id,
      uploadUrl: signed.uploadUrl,
      fields: signed.fields,
      expiresAt: signed.expiresAt,
    };
  }

  /**
   * Lets the applicant re-open a document they attached, from the tracking link. Logged like
   * a reviewer's view (without an actor), so the audit trail shows every read of the file.
   */
  async openDocumentForApplicant(
    applicationId: string,
    trackingToken: string,
    documentId: string,
  ) {
    await this.loadForApplicant(applicationId, trackingToken);

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
      actorId: null,
      payload: { documentId, docType: document.docType, viewer: "applicant" },
    });

    const download = await documentStorage.download(
      document.storageKey,
      document.format,
    );
    return { ...download, fileName: document.fileName ?? documentId };
  }

  /* ------------------------------------------------------------------ */
  /* Draft                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Saves whatever the form sends, while the application is a draft or back for revision.
   * Only shapes are checked here; the full rules run on submit, so a half-filled draft can
   * always be saved.
   */
  async saveDraft(
    applicationId: string,
    trackingToken: string,
    body: SaveApplicationBody,
  ): Promise<{ application: ApplicationPublicResponse; notified: boolean }> {
    const application = await this.loadForApplicant(applicationId, trackingToken);
    if (!isEditable(application.status)) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_NOT_EDITABLE);
    }

    const data: Prisma.OrganizationApplicationUpdateInput = {};

    if (body.orgType !== undefined) {
      if (body.orgType && !isOneOf(body.orgType, OrgType)) {
        throw new HttpError(
          HTTP_STATUS.INVALID_INPUT.withMessage("Unknown organization type"),
        );
      }
      data.orgType = body.orgType || null;
    }
    if (body.profile) {
      const profile = this.sanitizeProfile({
        ...((application.profile ?? {}) as Partial<ApplicationProfileInput>),
        ...body.profile,
      });
      data.profile = profile as unknown as Prisma.InputJsonValue;
      data.contactEmail = profile.contactEmail ?? application.submitterEmail;
    }
    if (body.channels) {
      data.channels = this.validateChannels(body.channels, {
        requireOne: false,
      }) as unknown as Prisma.InputJsonValue;
    }
    if (body.legalRepresentative) {
      Object.assign(data, this.sanitizeLegalRep(body.legalRepresentative));
    }
    if (body.consent === true && !application.consentedAt) {
      data.consentedAt = new Date();
    } else if (body.consent === false) {
      data.consentedAt = null;
    }

    const owners =
      body.owners !== undefined ? normalizeOwnerInputs(body.owners) : null;

    // Every check happens before anything is written, so a rejected save leaves the draft
    // exactly as it was.
    const newDocumentIds = await this.assertDocumentsOwnedBy(
      application.submitterEmail,
      body.documentIds ?? [],
    );
    const current =
      await organizationApplicationRepository.findByIdWithRelations(
        application.id,
      );
    const currentIds = new Set((current?.documents ?? []).map((d) => d.id));
    const removeIds = [...new Set(body.removeDocumentIds ?? [])];
    if (removeIds.some((id) => !currentIds.has(id))) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_DOCUMENT_NOT_FOUND);
    }
    const addedIds = newDocumentIds.filter((id) => !currentIds.has(id));
    if (
      currentIds.size - removeIds.length + addedIds.length >
      APPLICATION_DOCUMENT_LIMITS.maxFilesPerApplication
    ) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_DOCUMENT_LIMIT);
    }
    if (owners) {
      const referenced = owners
        .map((o) => o.nationalIdDocumentId)
        .filter((id): id is string => Boolean(id));
      const available = new Set([...currentIds, ...addedIds]);
      for (const id of removeIds) available.delete(id);
      if (referenced.some((id) => !available.has(id))) {
        throw new HttpError(
          HTTP_STATUS.ORGANIZATION_DOCUMENT_NOT_FOUND.withMessage(
            "An owner points at a document that is not attached to this application",
          ),
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      await organizationApplicationRepository.lockForUpdate(tx, application.id);
      const locked = await tx.organizationApplication.findUniqueOrThrow({
        where: { id: application.id },
        select: { status: true },
      });
      if (!isEditable(locked.status)) {
        throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_NOT_EDITABLE);
      }

      if (removeIds.length) {
        await tx.organizationApplicationDocument.updateMany({
          where: { id: { in: removeIds } },
          data: { deletedAt: new Date() },
        });
      }
      if (addedIds.length) {
        await tx.organizationApplicationDocument.updateMany({
          where: { id: { in: addedIds } },
          data: { applicationId: application.id },
        });
      }
      if (owners) {
        await this.syncOwners(tx, application.id, owners);
      }
      if (Object.keys(data).length) {
        await tx.organizationApplication.update({
          where: { id: application.id },
          data,
        });
      }
    });

    const notified = body.notifySubmitter
      ? await this.notifyDraftUpdated(application.id, trackingToken)
      : false;

    return {
      application: await this.getForApplicant(application.id, trackingToken),
      notified,
    };
  }

  /**
   * "Draft updated" email after a manual save. Only the "Save draft" button asks for it —
   * "Continue" saves too, and mailing on every step would bury the inbox. Capped at one per
   * application per `DRAFT_UPDATE_NOTICE_COOLDOWN_MS`, recorded as an event so the cap
   * survives restarts. Also a tripwire: if someone else holds the link, the owner of the
   * mailbox sees the draft change. A failed send never fails the save.
   */
  private async notifyDraftUpdated(
    applicationId: string,
    trackingToken: string,
  ): Promise<boolean> {
    const last = await organizationApplicationRepository.findLatestEvent(
      applicationId,
      ApplicationEventType.DRAFT_UPDATE_NOTIFIED,
    );
    const now = new Date();
    if (
      last &&
      now.getTime() - last.createdAt.getTime() < DRAFT_UPDATE_NOTICE_COOLDOWN_MS
    ) {
      return false;
    }

    const application =
      await organizationApplicationRepository.findById(applicationId);
    if (!application) return false;

    await organizationApplicationRepository.recordEvent({
      applicationId,
      eventType: ApplicationEventType.DRAFT_UPDATE_NOTIFIED,
    });

    const profile = (application.profile ?? {}) as Partial<ApplicationProfileInput>;
    void enqueueApplicationDraftUpdatedEmail({
      toEmail: application.submitterEmail,
      applicationCode: application.code,
      organizationName: profile.name ?? "",
      savedAt: new Intl.DateTimeFormat("vi-VN", {
        timeZone: "Asia/Ho_Chi_Minh",
        dateStyle: "short",
        timeStyle: "short",
      }).format(now),
      editUrl: buildApplicationEditUrl(application.id, trackingToken),
    }).catch((err) => {
      console.warn(
        "[organization-application] failed to send the draft-updated email",
        err,
      );
    });
    return true;
  }

  /**
   * Makes the stored owner list match `owners`, keyed by email. Rows that disappear are
   * marked removed and their link is voided — never deleted, the history has to stay
   * traceable. A removed person who is added back starts over as PENDING.
   */
  private async syncOwners(
    tx: Prisma.TransactionClient,
    applicationId: string,
    owners: ReturnType<typeof normalizeOwnerInputs>,
  ): Promise<void> {
    const existing = await tx.organizationApplicationOwner.findMany({
      where: { applicationId },
    });
    const byEmail = new Map(existing.map((row) => [row.email, row]));
    const wanted = new Set(owners.map((o) => o.email));
    const now = new Date();

    for (const owner of owners) {
      const row = byEmail.get(owner.email);
      const fields = {
        fullName: owner.fullName,
        isLegalRep: Boolean(owner.isLegalRep),
        nationalIdDocumentId: owner.nationalIdDocumentId ?? null,
      };
      if (!row) {
        await tx.organizationApplicationOwner.create({
          data: { applicationId, email: owner.email, ...fields },
        });
      } else if (row.removedAt) {
        await tx.organizationApplicationOwner.update({
          where: { id: row.id },
          data: {
            ...fields,
            removedAt: null,
            status: OwnerCandidateStatus.PENDING,
            confirmTokenHash: null,
            expiresAt: null,
            respondedAt: null,
            declineReason: null,
            confirmIp: null,
            confirmUa: null,
          },
        });
      } else {
        await tx.organizationApplicationOwner.update({
          where: { id: row.id },
          data: fields,
        });
      }
    }

    for (const row of existing) {
      if (row.removedAt || wanted.has(row.email)) continue;
      await tx.organizationApplicationOwner.update({
        where: { id: row.id },
        data: { removedAt: now, confirmTokenHash: null },
      });
      await organizationApplicationRepository.recordEvent({
        tx,
        applicationId,
        eventType: ApplicationEventType.OWNER_CANDIDATE_REMOVED,
        payload: {
          candidateId: row.id,
          email: row.email,
          previousStatus: row.status,
        },
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Step 1 — submit                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Runs every rule, then sends the owners their confirmation links. All checks that could
   * fail later (suspended account, 3-org cap, invitation spam cap) run here, before a single
   * email goes out — failing after 14 days of waiting on confirmations would be far worse.
   */
  async submitApplication(
    applicationId: string,
    trackingToken: string,
    body: SubmitApplicationBody,
    meta: ConfirmationRequestMeta,
  ): Promise<ApplicationPublicResponse> {
    const loaded = await this.loadForApplicant(applicationId, trackingToken);
    const application =
      await organizationApplicationRepository.findByIdWithOwners(loaded.id);
    if (!application) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_NOT_FOUND);
    }
    if (!isEditable(application.status)) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_NOT_EDITABLE);
    }

    if (!body.consent && !application.consentedAt) {
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage(
          "Consent to personal data processing is required",
        ),
      );
    }
    if (!application.orgType || !isOneOf(application.orgType, OrgType)) {
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage("Organization type is required"),
      );
    }
    const profile = this.validateProfile(
      (application.profile ?? {}) as Partial<ApplicationProfileInput>,
      application.submitterEmail,
    );
    this.validateChannels(this.channelsOf(application), { requireOne: true });

    const owners = application.owners;
    validateOwnerList(owners, application.submitterEmail);
    const declined = owners.find(
      (o) => o.status === OwnerCandidateStatus.DECLINED,
    );
    if (declined) {
      throw withEmailDetails(
        HTTP_STATUS.OWNER_DECLINED_MUST_BE_REPLACED,
        declined.email,
      );
    }

    await this.assertOwnersEligible(application.id, application.submitterEmail, owners);

    const snapshot = buildConfirmationSnapshot({
      name: profile.name,
      orgType: application.orgType,
      owners,
    });
    const contentFingerprints = this.contentFingerprints(application, owners);
    const wasDraft = application.status === ApplicationStatus.DRAFT;
    const now = new Date();
    const issued: { candidate: CandidateRow; rawToken: string }[] = [];

    const result = await prisma.$transaction(async (tx) => {
      await organizationApplicationRepository.lockForUpdate(tx, application.id);
      const fresh = await organizationApplicationRepository.findByIdWithOwners(
        application.id,
        tx,
      );
      if (!fresh || !isEditable(fresh.status)) {
        throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_NOT_EDITABLE);
      }

      const previous = (fresh.confirmationSnapshot ?? null) as {
        snapshot?: Record<string, unknown>;
        fields?: Record<string, string>;
      } | null;
      const reset = snapshotsDiffer(
        (previous?.snapshot ?? null) as Prisma.JsonValue,
        snapshot,
      );

      for (const candidate of fresh.owners) {
        const isSubmitter = candidate.email === fresh.submitterEmail;
        if (isSubmitter) {
          // The submitter's mailbox passed the OTP, which is the same proof a confirmation
          // link gives; recording it keeps "every owner confirmed" literally true.
          if (candidate.status !== OwnerCandidateStatus.CONFIRMED || reset) {
            await tx.organizationApplicationOwner.update({
              where: { id: candidate.id },
              data: {
                status: OwnerCandidateStatus.CONFIRMED,
                respondedAt: now,
                confirmIp: meta.ip,
                confirmUa: meta.userAgent,
                confirmTokenHash: null,
                expiresAt: null,
              },
            });
          }
          continue;
        }

        const needsLink =
          candidate.status === OwnerCandidateStatus.EXPIRED ||
          (candidate.status === OwnerCandidateStatus.CONFIRMED && reset) ||
          (candidate.status === OwnerCandidateStatus.PENDING &&
            (!candidate.confirmTokenHash ||
              !candidate.expiresAt ||
              candidate.expiresAt <= now));
        if (!needsLink) continue;

        const token = newConfirmToken(now);
        const updated = await tx.organizationApplicationOwner.update({
          where: { id: candidate.id },
          data: {
            ...token.data,
            status: OwnerCandidateStatus.PENDING,
            respondedAt: null,
            confirmIp: null,
            confirmUa: null,
          },
        });
        issued.push({ candidate: updated, rawToken: token.raw });
      }

      const remaining = await tx.organizationApplicationOwner.count({
        where: {
          applicationId: fresh.id,
          removedAt: null,
          status: { not: OwnerCandidateStatus.CONFIRMED },
        },
      });
      const nextStatus =
        remaining === 0
          ? ApplicationStatus.PENDING_REVIEW
          : ApplicationStatus.AWAITING_OWNER_CONFIRMATION;

      await tx.organizationApplication.update({
        where: { id: fresh.id },
        data: {
          status: nextStatus,
          submittedAt: now,
          consentedAt: fresh.consentedAt ?? now,
          contactEmail: profile.contactEmail,
          confirmationSnapshot: {
            snapshot,
            fields: contentFingerprints,
          } as unknown as Prisma.InputJsonValue,
          // A resubmission is reviewed from scratch.
          reviewerId: null,
          claimedAt: null,
          reviewNote: null,
          rejectReason: null,
        },
      });

      const changedFields = previous?.fields
        ? Object.keys(contentFingerprints).filter(
            (key) => previous.fields?.[key] !== contentFingerprints[key],
          )
        : [];
      await organizationApplicationRepository.recordEvent({
        tx,
        applicationId: fresh.id,
        eventType: wasDraft
          ? ApplicationEventType.SUBMITTED
          : ApplicationEventType.RESUBMITTED,
        payload: {
          orgType: fresh.orgType,
          ownerCount: fresh.owners.length,
          invitationsSent: issued.length,
          ...(wasDraft ? {} : { changedFields }),
        },
      });
      if (reset) {
        await organizationApplicationRepository.recordEvent({
          tx,
          applicationId: fresh.id,
          eventType: ApplicationEventType.OWNER_CONFIRMATIONS_RESET,
          payload: { reason: "name, type, legal representative or owner list changed" },
        });
      }
      if (nextStatus === ApplicationStatus.PENDING_REVIEW) {
        await organizationApplicationRepository.recordEvent({
          tx,
          applicationId: fresh.id,
          eventType: ApplicationEventType.READY_FOR_REVIEW,
        });
      }

      return { owners: fresh.owners };
    });

    sendConfirmationEmails({
      issued,
      allOwners: result.owners,
      submitterEmail: application.submitterEmail,
      orgType: application.orgType,
      profile,
    });

    if (wasDraft) {
      const tracking = await organizationApplicationOtpService.issueTrackingToken(
        application.submitterEmail,
      );
      void enqueueApplicationReceivedEmail({
        toEmail: application.submitterEmail,
        organizationName: profile.name,
        applicationCode: application.code,
        trackUrl: buildApplicationTrackUrl(application.id, tracking.token),
      }).catch((err) => {
        console.warn(
          "[organization-application] failed to send the acknowledgement email",
          err,
        );
      });
    }

    return this.getForApplicant(application.id, trackingToken);
  }

  /**
   * The early checks from the design, run for every owner:
   *   - suspended account → OWNER_SUSPENDED
   *   - already owns `OWNER_ORG_LIMIT` organizations → OWNER_QUOTA_EXCEEDED (checked again,
   *     under a lock, at approval)
   *   - listed on too many other in-flight applications → TOO_MANY_PENDING_INVITES
   *   - opted out via "I'm not involved" → OWNER_INVITE_BLOCKED
   */
  async assertOwnersEligible(
    applicationId: string,
    submitterEmail: string,
    owners: { email: string }[],
  ): Promise<void> {
    const emails = owners.map((o) => o.email);

    let accounts;
    try {
      accounts = await lookupUsersByEmails(emails);
    } catch (error) {
      console.error("[organization-application] identity lookup failed", error);
      throw new HttpError(
        HTTP_STATUS.SERVICE_UNAVAILABLE.withMessage(
          "Could not verify the owners right now, please try again",
        ),
      );
    }

    const userIds = [...accounts.values()].map((u) => u.id);
    const [ownerCounts, candidacies, blocked] = await Promise.all([
      organizationMemberRepository.countActiveOwnerOrgs(userIds),
      organizationApplicationRepository.countOtherCandidacies(
        emails,
        applicationId,
      ),
      organizationApplicationRepository.findBlockedEmails(
        emails.filter((e) => e !== submitterEmail),
      ),
    ]);

    for (const owner of owners) {
      const account = accounts.get(owner.email);
      if (account?.status === IdentityUserStatus.INACTIVE) {
        throw withEmailDetails(HTTP_STATUS.OWNER_SUSPENDED, owner.email);
      }
      if (account && (ownerCounts.get(account.id) ?? 0) >= OWNER_ORG_LIMIT) {
        throw withEmailDetails(HTTP_STATUS.OWNER_QUOTA_EXCEEDED, owner.email);
      }
      if ((candidacies.get(owner.email) ?? 0) >= MAX_PENDING_INVITES_PER_EMAIL) {
        throw withEmailDetails(HTTP_STATUS.TOO_MANY_PENDING_INVITES, owner.email);
      }
      if (blocked.has(owner.email)) {
        throw withEmailDetails(HTTP_STATUS.OWNER_INVITE_BLOCKED, owner.email);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Resend / withdraw / read                                            */
  /* ------------------------------------------------------------------ */

  /**
   * New link for one candidate who has not answered. As many times as the submitter needs,
   * but at least an hour apart (the only anti-spam guard left). Overwriting the hash voids the
   * previous link and restarts the 14 days.
   */
  async resendOwnerInvite(
    applicationId: string,
    trackingToken: string,
    candidateId: string,
  ): Promise<ApplicationPublicResponse> {
    const application = await this.loadForApplicant(applicationId, trackingToken);
    await this.resendCandidate(application.id, candidateId);
    return this.getForApplicant(application.id, trackingToken);
  }

  /**
   * New confirmation link for one pending candidate, shared by the anonymous applicant
   * (tracking link) and an owner resending an ADD_OWNER proposal (membership). The caller
   * has already been authorised.
   */
  async resendCandidate(applicationId: string, candidateId: string): Promise<void> {
    const application =
      await organizationApplicationRepository.findById(applicationId);
    if (!application) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_NOT_FOUND);
    }
    const now = new Date();

    const { candidate, rawToken, owners } = await prisma.$transaction(
      async (tx) => {
        await organizationApplicationRepository.lockForUpdate(tx, application.id);
        const fresh = await organizationApplicationRepository.findByIdWithOwners(
          application.id,
          tx,
        );
        if (
          !fresh ||
          (fresh.status !== ApplicationStatus.AWAITING_OWNER_CONFIRMATION &&
            fresh.status !== ApplicationStatus.NEEDS_REVISION)
        ) {
          throw new HttpError(HTTP_STATUS.APPLICATION_NOT_ACTIVE);
        }
        const target = fresh.owners.find((o) => o.id === candidateId);
        if (!target || target.status !== OwnerCandidateStatus.PENDING) {
          throw new HttpError(
            HTTP_STATUS.NOT_FOUND.withMessage(
              "No pending owner with this id on the application",
            ),
          );
        }
        const earliest = nextResendAt(target);
        if (earliest && earliest > now) {
          throw new HttpError(
            HTTP_STATUS.RESEND_TOO_SOON.withMessage(
              `You can resend after ${earliest.toISOString()}`,
            ),
          );
        }

        const token = newConfirmToken(now);
        const updated = await tx.organizationApplicationOwner.update({
          where: { id: target.id },
          data: token.data,
        });
        await organizationApplicationRepository.recordEvent({
          tx,
          applicationId: fresh.id,
          eventType: ApplicationEventType.OWNER_INVITE_RESENT,
          payload: { candidateId: target.id, sentCount: updated.sentCount },
        });
        return { candidate: updated, rawToken: token.raw, owners: fresh.owners };
      },
    );

    sendConfirmationEmails({
      issued: [{ candidate, rawToken }],
      allOwners: owners,
      submitterEmail: application.submitterEmail,
      orgType: application.orgType,
      profile: (application.profile ?? {}) as Partial<ApplicationProfileInput>,
      isAddOwner: application.type === ApplicationType.ADD_OWNER,
    });
  }

  /**
   * Allowed in any state before a decision, including while waiting on confirmations — the
   * longest stretch and the likeliest time to change one's mind. Voids every link still out
   * there, and tells owners who already confirmed.
   */
  async withdrawApplication(
    applicationId: string,
    trackingToken: string,
  ): Promise<ApplicationPublicResponse> {
    const application = await this.loadForApplicant(applicationId, trackingToken);

    const confirmed = await prisma.$transaction(async (tx) => {
      await organizationApplicationRepository.lockForUpdate(tx, application.id);
      const fresh = await organizationApplicationRepository.findByIdWithOwners(
        application.id,
        tx,
      );
      if (!fresh || !isOpenApplicationStatus(fresh.status)) {
        throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_ALREADY_DECIDED);
      }

      await tx.organizationApplication.update({
        where: { id: fresh.id },
        data: { status: ApplicationStatus.WITHDRAWN },
      });
      // Unanswered links stop working. The hashes stay, so opening one explains that the
      // application was withdrawn rather than claiming the link never existed.
      await tx.organizationApplicationOwner.updateMany({
        where: {
          applicationId: fresh.id,
          status: OwnerCandidateStatus.PENDING,
        },
        data: { expiresAt: new Date() },
      });
      await organizationApplicationRepository.recordEvent({
        tx,
        applicationId: fresh.id,
        eventType: ApplicationEventType.WITHDRAWN,
        payload: { previousStatus: fresh.status },
      });

      return fresh.owners.filter(
        (o) =>
          o.status === OwnerCandidateStatus.CONFIRMED &&
          o.email !== fresh.submitterEmail,
      );
    });

    const profile = (application.profile ?? {}) as Partial<ApplicationProfileInput>;
    for (const owner of confirmed) {
      void enqueueApplicationWithdrawnNoticeEmail({
        toEmail: owner.email,
        organizationName: profile.name ?? application.code,
        submitterEmail: application.submitterEmail,
      }).catch((err) => {
        console.warn(
          "[organization-application] failed to send a withdrawal notice",
          err,
        );
      });
    }

    return this.getForApplicant(application.id, trackingToken);
  }

  /** What the applicant sees behind their tracking link. */
  async getForApplicant(
    applicationId: string,
    trackingToken: string,
  ): Promise<ApplicationPublicResponse> {
    const email =
      await organizationApplicationOtpService.resolveTrackingToken(
        trackingToken,
      );
    const application =
      await organizationApplicationRepository.findByIdWithRelations(
        applicationId,
      );
    if (!application || application.submitterEmail !== email) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_NOT_FOUND);
    }
    return this.toPublicResponse(
      application,
      application.documents,
      application.owners,
    );
  }

  /* ------------------------------------------------------------------ */
  /* Shared helpers                                                      */
  /* ------------------------------------------------------------------ */

  private async loadForApplicant(
    applicationId: string,
    trackingToken: string,
  ): Promise<ApplicationRow> {
    const email =
      await organizationApplicationOtpService.resolveTrackingToken(
        trackingToken,
      );
    const application =
      await organizationApplicationRepository.findById(applicationId);
    if (!application || application.submitterEmail !== email) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_NOT_FOUND);
    }
    return application;
  }

  private contentFingerprints(
    application: ApplicationRow,
    owners: CandidateRow[],
  ): Record<string, string> {
    const profile = (application.profile ?? {}) as Partial<ApplicationProfileInput>;
    const values: Record<(typeof TRACKED_FIELDS)[number], unknown> = {
      orgType: application.orgType,
      "profile.name": profile.name,
      "profile.description": profile.description,
      "profile.address": profile.address,
      "profile.logoUrl": profile.logoUrl,
      "profile.backgroundUrl": profile.backgroundUrl,
      "profile.contactEmail": profile.contactEmail,
      "profile.location": [profile.latitude, profile.longitude],
      channels: application.channels,
      legalRepresentative: [
        application.legalRepIdType,
        application.legalRepIdHash,
        application.legalRepPhone,
        application.legalRepPosition,
      ],
      owners: owners.map((o) => [o.email, o.fullName, o.isLegalRep]),
    };
    const out: Record<string, string> = {};
    for (const key of TRACKED_FIELDS) out[key] = fingerprint(values[key]);
    return out;
  }

  /** Trims a partial profile for a draft; only present values are checked. */
  private sanitizeProfile(
    profile: Partial<ApplicationProfileInput>,
  ): Partial<ApplicationProfileInput> {
    const contactEmail = profile.contactEmail?.trim().toLowerCase() || null;
    if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage("profile.contact_email is invalid"),
      );
    }
    return {
      name: profile.name?.trim() || undefined,
      contactEmail,
      logoUrl: profile.logoUrl?.trim() || undefined,
      backgroundUrl: profile.backgroundUrl?.trim() || null,
      address: profile.address?.trim() || null,
      latitude: this.validateCoordinate(profile.latitude, "latitude", 90),
      longitude: this.validateCoordinate(profile.longitude, "longitude", 180),
      description: profile.description?.trim() || null,
    };
  }

  /**
   * Submit-time profile rules. The contact email is the organization's public address and
   * defaults to the submitter's; it is only ever used to contact the organization.
   */
  private validateProfile(
    profile: Partial<ApplicationProfileInput>,
    submitterEmail: string,
  ): ApplicationProfileInput {
    const clean = this.sanitizeProfile(profile);
    if (!clean.name) {
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage("profile.name is required"),
      );
    }
    if (!clean.logoUrl) {
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage("profile.logo_url is required"),
      );
    }
    return {
      ...clean,
      name: clean.name,
      logoUrl: clean.logoUrl,
      contactEmail: clean.contactEmail || submitterEmail,
    };
  }

  /**
   * Coordinates are optional — the applicant may skip the map — but a value that is present
   * has to be a real one, because it ends up on the organization and later on a map.
   */
  private validateCoordinate(
    value: number | null | undefined,
    field: "latitude" | "longitude",
    bound: number,
  ): number | null {
    if (value == null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage(`profile.${field} must be a number`),
      );
    }
    if (value < -bound || value > bound) {
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage(
          `profile.${field} must be between -${bound} and ${bound}`,
        ),
      );
    }
    return value;
  }

  private channelsOf(application: ApplicationRow): ApplicationChannelInput[] {
    return Array.isArray(application.channels)
      ? (application.channels as unknown as ApplicationChannelInput[])
      : [];
  }

  private validateChannels(
    channels: ApplicationChannelInput[],
    opts: { requireOne: boolean },
  ): ApplicationChannelInput[] {
    if (opts.requireOne && channels.length === 0) {
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage(
          "At least one official channel is required",
        ),
      );
    }
    return channels.map((channel) => {
      if (!isOneOf(channel.type, OrganizationChannelType)) {
        throw new HttpError(
          HTTP_STATUS.INVALID_INPUT.withMessage(
            `Unknown channel type: ${channel.type}`,
          ),
        );
      }
      if (!/^https?:\/\//i.test(channel.url?.trim() ?? "")) {
        throw new HttpError(
          HTTP_STATUS.INVALID_INPUT.withMessage(
            "Channel urls must start with http:// or https://",
          ),
        );
      }
      return {
        type: channel.type,
        url: channel.url.trim(),
        isPrimary: Boolean(channel.isPrimary),
      };
    });
  }

  /**
   * Splits the representative's ID number into a hash and its last 4 characters. The raw
   * number is dropped here and never reaches the database. Fields left out are kept.
   */
  private sanitizeLegalRep(
    input: LegalRepresentativeInput,
  ): Prisma.OrganizationApplicationUpdateInput {
    const data: Prisma.OrganizationApplicationUpdateInput = {};
    if (input.idType !== undefined) {
      if (input.idType && !isOneOf(input.idType, LegalRepIdType)) {
        throw new HttpError(
          HTTP_STATUS.INVALID_INPUT.withMessage(
            "Unknown legal_representative.id_type",
          ),
        );
      }
      data.legalRepIdType = input.idType || null;
    }
    const idNumber = input.idNumber?.trim();
    if (idNumber) {
      if (idNumber.length < 4) {
        throw new HttpError(
          HTTP_STATUS.INVALID_INPUT.withMessage(
            "legal_representative.id_number is too short",
          ),
        );
      }
      data.legalRepIdHash = hashOpaqueToken(idNumber.toUpperCase());
      data.legalRepIdLast4 = idNumber.slice(-4);
    }
    if (input.phone !== undefined) data.legalRepPhone = input.phone?.trim() || null;
    if (input.position !== undefined) {
      data.legalRepPosition = input.position?.trim() || null;
    }
    return data;
  }

  private async assertDocumentsOwnedBy(
    submitterEmail: string,
    documentIds: string[],
  ): Promise<string[]> {
    if (documentIds.length === 0) return [];
    if (documentIds.length > APPLICATION_DOCUMENT_LIMITS.maxFilesPerApplication) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_DOCUMENT_LIMIT);
    }

    const unique = [...new Set(documentIds)];
    const documents =
      await organizationApplicationRepository.findDocumentsByIds(unique);
    if (documents.length !== unique.length) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_DOCUMENT_NOT_FOUND);
    }
    for (const document of documents) {
      if (document.submissionEmail !== submitterEmail) {
        throw new HttpError(HTTP_STATUS.ORGANIZATION_DOCUMENT_NOT_FOUND);
      }
    }
    return documents.map((d) => d.id);
  }

  /** `ORG-XXXXXXXX`; retried on the (unlikely) unique clash. */
  async createWithUniqueCode(
    data: Omit<Prisma.OrganizationApplicationCreateInput, "code">,
  ) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = `ORG-${randomBytes(4).toString("hex").toUpperCase()}`;
      try {
        return await organizationApplicationRepository.create({ ...data, code });
      } catch (error) {
        const isCodeClash =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002" &&
          String(error.meta?.target ?? "").includes("code");
        if (isCodeClash && attempt < 4) continue;
        throw error;
      }
    }
    throw new HttpError(
      HTTP_STATUS.CONFLICT.withMessage(
        "Unable to allocate a unique application code",
      ),
    );
  }

  toDocumentResponse(row: DocumentRow): ApplicationDocumentResponse {
    return {
      id: row.id,
      docType: row.docType,
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      purgedAt: row.purgedAt,
      createdAt: row.createdAt,
    };
  }

  legalRepresentativeOf(
    row: ApplicationRow,
    owners: CandidateRow[],
  ): LegalRepresentativeResponse {
    const rep = owners.find((o) => o.isLegalRep);
    return {
      fullName: rep?.fullName ?? null,
      email: rep?.email ?? null,
      idType: row.legalRepIdType,
      // Only the last 4 characters are ever stored.
      idLast4: row.legalRepIdLast4,
      phone: row.legalRepPhone,
      position: row.legalRepPosition,
    };
  }

  toPublicResponse(
    row: ApplicationRow,
    documents: DocumentRow[],
    owners: CandidateRow[],
  ): ApplicationPublicResponse {
    return {
      id: row.id,
      code: row.code,
      type: row.type,
      orgType: row.orgType,
      status: row.status,
      submitterEmail: row.submitterEmail,
      contactEmail: row.contactEmail,
      profile: row.profile,
      channels: row.channels,
      documents: documents.map((d) => this.toDocumentResponse(d)),
      owners: owners.map((o) => toOwnerCandidateResponse(o, row.submitterEmail)),
      confirmedCount: owners.filter(
        (o) => o.status === OwnerCandidateStatus.CONFIRMED,
      ).length,
      totalOwners: owners.length,
      legalRepresentative: this.legalRepresentativeOf(row, owners),
      reviewNote: row.reviewNote,
      rejectReason: row.rejectReason,
      organizationId: row.organizationId,
      consentedAt: row.consentedAt,
      createdAt: row.createdAt,
      submittedAt: row.submittedAt,
      reviewedAt: row.reviewedAt,
    };
  }
}

export const organizationApplicationService =
  new OrganizationApplicationService();
