import { Prisma } from "@prisma/client";
import { randomBytes } from "crypto";
import {
  APPLICATION_DOCUMENT_LIMITS,
  ApplicationDocType,
  ApplicationEventType,
  ApplicationStatus,
  DEFAULT_LEGAL_REP_ORG_LIMIT,
  LegalRepIdType,
  OrgType,
  OrganizationChannelType,
} from "@da2/constants";
import { HTTP_STATUS, HttpError } from "../../constants/http-status";
import { hashOpaqueToken } from "../../utils/token-hash";
import {
  ApplicationChannelInput,
  ApplicationDocumentResponse,
  ApplicationProfileInput,
  ApplicationPublicResponse,
  CreateApplicationBody,
  LegalRepresentativeInput,
  PresignApplicationDocumentResponse,
  UpdateApplicationBody,
} from "./organization-application.dto";
import { organizationApplicationRepository } from "./organization-application.repository";
import { organizationApplicationOtpService } from "./organization-application-otp.service";
import {
  enqueueApplicationReceivedEmail,
} from "./organization-application-notify.client";
import { buildApplicationTrackUrl } from "./organization-application-urls";
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

const MIME_TO_FORMAT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

function isOneOf(value: string, allowed: Record<string, string>): boolean {
  return Object.values(allowed).includes(value);
}

/** Profile keys whose edits are worth telling a reviewer about (contact email is fixed). */
const TRACKED_PROFILE_KEYS = [
  "name",
  "description",
  "address",
  "logoUrl",
  "backgroundUrl",
  "latitude",
  "longitude",
] as const;

function diffProfile(
  before: Partial<ApplicationProfileInput>,
  after: ApplicationProfileInput,
): string[] {
  return TRACKED_PROFILE_KEYS.filter(
    (key) => (before[key] ?? null) !== (after[key] ?? null),
  ).map((key) => `profile.${key}`);
}

function channelsKey(channels: ApplicationChannelInput[]): string {
  return JSON.stringify(
    channels.map((channel) => ({
      type: channel.type,
      url: channel.url,
      isPrimary: Boolean(channel.isPrimary),
    })),
  );
}

export class OrganizationApplicationService {
  /* ------------------------------------------------------------------ */
  /* P1 — documents                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Hands the browser short-lived, signed parameters so it can upload one file straight to
   * private storage. The row is created up front (still detached from any application) so the
   * submit call can verify the file really came from this mailbox.
   */
  async presignDocument(
    submissionEmail: string,
    input: {
      docType: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
    },
  ): Promise<PresignApplicationDocumentResponse> {
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
      await organizationApplicationRepository.countUnattachedDocuments(
        submissionEmail,
      );
    if (pending >= APPLICATION_DOCUMENT_LIMITS.maxFilesPerApplication) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_DOCUMENT_LIMIT);
    }

    const signed = documentStorage.createSignedUpload({
      scopeId: hashOpaqueToken(submissionEmail).slice(0, 16),
      docType: input.docType,
      format,
    });

    const document = await organizationApplicationRepository.createDocument({
      submissionEmail,
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
   * Upload slot for a resubmission. The one-time submission token is spent by then, so the
   * tracking link is the credential — and only while a reviewer is waiting on more paperwork.
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
    const email =
      await organizationApplicationOtpService.resolveTrackingToken(
        trackingToken,
      );
    const application = await this.loadForApplicant(applicationId, email);
    if (application.status !== ApplicationStatus.NEEDS_MORE_INFO) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_NOT_EDITABLE);
    }
    return this.presignDocument(email, input);
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
    const email =
      await organizationApplicationOtpService.resolveTrackingToken(
        trackingToken,
      );
    await this.loadForApplicant(applicationId, email);

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
  /* P2 — submission                                                     */
  /* ------------------------------------------------------------------ */

  async createApplication(
    submissionEmail: string,
    submissionToken: string,
    body: CreateApplicationBody,
    submittedByUserId?: string,
  ): Promise<{ application: ApplicationPublicResponse; trackingToken: string }> {
    if (!body.consent) {
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage(
          "Consent to personal data processing is required",
        ),
      );
    }
    if (!isOneOf(body.orgType, OrgType)) {
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage("Unknown organization type"),
      );
    }

    const profile = this.validateProfile(body.profile, submissionEmail);
    const channels = this.validateChannels(body.channels);
    const legalRep = this.validateLegalRepresentative(body.legalRepresentative);

    const existingOpen =
      await organizationApplicationRepository.findOpenByContactEmail(
        submissionEmail,
      );
    if (existingOpen) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_ALREADY_OPEN);
    }

    if (legalRep) {
      await this.assertLegalRepUnderLimit(legalRep.idHash);
    }

    const documentIds = await this.assertDocumentsOwnedBy(
      submissionEmail,
      body.documentIds ?? [],
    );

    const now = new Date();
    const created = await this.createWithUniqueCode({
      orgType: body.orgType,
      status: ApplicationStatus.SUBMITTED,
      profile: profile as unknown as Prisma.InputJsonValue,
      channels: channels as unknown as Prisma.InputJsonValue,
      contactEmail: submissionEmail,
      legalRepName: legalRep?.fullName ?? null,
      legalRepPhone: legalRep?.phone ?? null,
      legalRepEmail: legalRep?.email ?? null,
      legalRepPosition: legalRep?.position ?? null,
      legalRepIdType: legalRep?.idType ?? null,
      legalRepIdHash: legalRep?.idHash ?? null,
      legalRepIdLast4: legalRep?.idLast4 ?? null,
      submittedByUserId: submittedByUserId ?? null,
      // The OTP already proved the mailbox; the organization inherits this and is never
      // asked to verify the same address a second time.
      emailVerifiedAt: now,
      consentedAt: now,
    });

    if (documentIds.length) {
      await organizationApplicationRepository.attachDocuments(
        created.id,
        documentIds,
      );
    }

    await organizationApplicationRepository.recordEvent({
      applicationId: created.id,
      eventType: ApplicationEventType.SUBMITTED,
      actorId: submittedByUserId ?? null,
      payload: { documentCount: documentIds.length, orgType: body.orgType },
    });

    await organizationApplicationOtpService.consumeSubmissionToken(
      submissionToken,
    );

    const tracking =
      await organizationApplicationOtpService.issueTrackingToken(
        submissionEmail,
      );

    void enqueueApplicationReceivedEmail({
      toEmail: submissionEmail,
      organizationName: profile.name,
      applicationCode: created.code,
      trackUrl: buildApplicationTrackUrl(created.id, tracking.token),
    }).catch((err) => {
      console.warn(
        "[organization-application] failed to send the acknowledgement email",
        err,
      );
    });

    // The submission token already proved this browser owns the mailbox, so it may hold the
    // same tracking credential the acknowledgement mail carries — the landing page needs it
    // to show the application without a trip to the inbox.
    return {
      application: this.toPublicResponse(created, []),
      trackingToken: tracking.token,
    };
  }

  /** Resubmission after a reviewer asked for more information. */
  async updateApplication(
    applicationId: string,
    trackingToken: string,
    body: UpdateApplicationBody,
  ): Promise<ApplicationPublicResponse> {
    const email =
      await organizationApplicationOtpService.resolveTrackingToken(
        trackingToken,
      );
    const application = await this.loadForApplicant(applicationId, email);

    if (application.status !== ApplicationStatus.NEEDS_MORE_INFO) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_NOT_EDITABLE);
    }

    const data: Prisma.OrganizationApplicationUpdateInput = {
      status: ApplicationStatus.SUBMITTED,
      // Hand the file back to the queue: a resubmission is reviewed from scratch.
      reviewerId: null,
      claimedAt: null,
      reviewNote: null,
    };

    // Names of what the applicant edited, for the reviewer's activity log. Values are left
    // out on purpose: the log must not become a second copy of the personal data.
    const changedFields: string[] = [];

    if (body.orgType) {
      if (!isOneOf(body.orgType, OrgType)) {
        throw new HttpError(
          HTTP_STATUS.INVALID_INPUT.withMessage("Unknown organization type"),
        );
      }
      data.orgType = body.orgType;
      if (body.orgType !== application.orgType) changedFields.push("orgType");
    }
    if (body.profile) {
      const profile = this.validateProfile(
        body.profile,
        application.contactEmail,
      );
      data.profile = profile as unknown as Prisma.InputJsonValue;
      changedFields.push(
        ...diffProfile(
          (application.profile ?? {}) as unknown as Partial<ApplicationProfileInput>,
          profile,
        ),
      );
    }
    if (body.channels) {
      const channels = this.validateChannels(body.channels);
      data.channels = channels as unknown as Prisma.InputJsonValue;
      if (
        channelsKey(channels) !==
        channelsKey(
          Array.isArray(application.channels)
            ? (application.channels as unknown as ApplicationChannelInput[])
            : [],
        )
      ) {
        changedFields.push("channels");
      }
    }
    if (body.legalRepresentative) {
      const legalRep = this.validateLegalRepresentative(
        body.legalRepresentative,
      );
      if (legalRep) {
        await this.assertLegalRepUnderLimit(legalRep.idHash, application.id);
        data.legalRepName = legalRep.fullName;
        data.legalRepPhone = legalRep.phone;
        data.legalRepEmail = legalRep.email;
        data.legalRepPosition = legalRep.position;
        data.legalRepIdType = legalRep.idType;
        data.legalRepIdHash = legalRep.idHash;
        data.legalRepIdLast4 = legalRep.idLast4;
        // The ID is only kept as a hash, so a replacement cannot be compared with the old one.
        changedFields.push("legalRepresentative");
      }
    }

    // Everything is checked before anything is written, so a rejected resubmission leaves the
    // application exactly as the reviewer last saw it.
    const newDocumentIds = await this.assertDocumentsOwnedBy(
      application.contactEmail,
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
    const keptCount = currentIds.size - removeIds.length;
    const addedCount = newDocumentIds.filter((id) => !currentIds.has(id)).length;
    if (
      keptCount + addedCount >
      APPLICATION_DOCUMENT_LIMITS.maxFilesPerApplication
    ) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_DOCUMENT_LIMIT);
    }

    for (const id of removeIds) {
      await organizationApplicationRepository.softDeleteDocument(id);
    }
    if (newDocumentIds.length) {
      await organizationApplicationRepository.attachDocuments(
        application.id,
        newDocumentIds,
      );
    }

    await organizationApplicationRepository.update(application.id, data);
    await organizationApplicationRepository.recordEvent({
      applicationId: application.id,
      eventType: ApplicationEventType.RESUBMITTED,
      payload: {
        changedFields,
        addedDocumentIds: newDocumentIds.filter((id) => !currentIds.has(id)),
        removedDocumentIds: removeIds,
      },
    });

    const reloaded =
      await organizationApplicationRepository.findByIdWithRelations(
        application.id,
      );
    if (!reloaded) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_NOT_FOUND);
    }
    return this.toPublicResponse(reloaded, reloaded.documents);
  }

  async withdrawApplication(
    applicationId: string,
    trackingToken: string,
  ): Promise<ApplicationPublicResponse> {
    const email =
      await organizationApplicationOtpService.resolveTrackingToken(
        trackingToken,
      );
    const application = await this.loadForApplicant(applicationId, email);

    if (
      application.status === ApplicationStatus.APPROVED ||
      application.status === ApplicationStatus.REJECTED ||
      application.status === ApplicationStatus.WITHDRAWN
    ) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_ALREADY_DECIDED);
    }

    const updated = await organizationApplicationRepository.update(
      application.id,
      { status: ApplicationStatus.WITHDRAWN },
    );
    await organizationApplicationRepository.recordEvent({
      applicationId: application.id,
      eventType: ApplicationEventType.WITHDRAWN,
    });

    return this.toPublicResponse(updated, []);
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
    if (!application || application.contactEmail !== email) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_NOT_FOUND);
    }
    return this.toPublicResponse(application, application.documents);
  }

  /* ------------------------------------------------------------------ */
  /* Shared helpers                                                      */
  /* ------------------------------------------------------------------ */

  private async loadForApplicant(applicationId: string, email: string) {
    const application =
      await organizationApplicationRepository.findById(applicationId);
    if (!application || application.contactEmail !== email) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_APPLICATION_NOT_FOUND);
    }
    return application;
  }

  private validateProfile(
    profile: ApplicationProfileInput | undefined,
    submissionEmail: string,
  ): ApplicationProfileInput {
    if (!profile?.name?.trim()) {
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage("profile.name is required"),
      );
    }
    if (!profile.logoUrl?.trim()) {
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage("profile.logo_url is required"),
      );
    }
    const contactEmail = profile.contactEmail?.trim().toLowerCase() ?? "";
    if (contactEmail !== submissionEmail) {
      // The submission token is bound to one mailbox; letting the body name a different
      // contact address would defeat the OTP entirely.
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage(
          "profile.contact_email must match the verified email address",
        ),
      );
    }
    return {
      name: profile.name.trim(),
      contactEmail,
      logoUrl: profile.logoUrl.trim(),
      backgroundUrl: profile.backgroundUrl?.trim() || null,
      address: profile.address?.trim() || null,
      latitude: this.validateCoordinate(profile.latitude, "latitude", 90),
      longitude: this.validateCoordinate(profile.longitude, "longitude", 180),
      description: profile.description?.trim() || null,
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

  private validateChannels(
    channels: ApplicationChannelInput[] | undefined,
  ): ApplicationChannelInput[] {
    const list = channels ?? [];
    if (list.length === 0) {
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage(
          "At least one official channel is required",
        ),
      );
    }
    return list.map((channel) => {
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
   * Splits the representative's ID number into a hash (used only to count how many
   * organizations one person stands for) and its last 4 characters. The raw number is
   * deliberately dropped here and never reaches the database.
   */
  private validateLegalRepresentative(
    input: LegalRepresentativeInput | undefined,
  ): {
    fullName: string;
    phone: string;
    email: string | null;
    position: string | null;
    idType: string;
    idHash: string;
    idLast4: string;
  } | null {
    if (!input) return null;

    if (!input.fullName?.trim() || !input.phone?.trim()) {
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage(
          "legal_representative requires full_name and phone",
        ),
      );
    }
    if (!isOneOf(input.idType, LegalRepIdType)) {
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage(
          "Unknown legal_representative.id_type",
        ),
      );
    }
    const idNumber = input.idNumber?.trim() ?? "";
    if (idNumber.length < 4) {
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage(
          "legal_representative.id_number is too short",
        ),
      );
    }

    return {
      fullName: input.fullName.trim(),
      phone: input.phone.trim(),
      email: input.email?.trim().toLowerCase() || null,
      position: input.position?.trim() || null,
      idType: input.idType,
      idHash: hashOpaqueToken(idNumber.toUpperCase()),
      idLast4: idNumber.slice(-4),
    };
  }

  /**
   * The cap counts open submissions as well as approved ones. Counting only approved
   * organizations would let one person file ten applications at once and slip through.
   *
   * It is not airtight — the same person using two different ID numbers produces two hashes —
   * so it stops careless duplication and lazy spam, not determined fraud.
   */
  private async assertLegalRepUnderLimit(
    idHash: string,
    excludeApplicationId?: string,
  ): Promise<void> {
    const [count, override] = await Promise.all([
      organizationApplicationRepository.countOpenByLegalRepHash(
        idHash,
        excludeApplicationId,
      ),
      organizationApplicationRepository.findLegalRepLimitOverride(idHash),
    ]);
    const limit = override ?? DEFAULT_LEGAL_REP_ORG_LIMIT;
    if (count >= limit) {
      throw new HttpError(
        HTTP_STATUS.LEGAL_REP_LIMIT_EXCEEDED.withMessage(
          `This legal representative already stands for ${count} organizations (limit ${limit})`,
        ),
      );
    }
  }

  private async assertDocumentsOwnedBy(
    submissionEmail: string,
    documentIds: string[],
  ): Promise<string[]> {
    if (documentIds.length === 0) return [];
    if (documentIds.length > APPLICATION_DOCUMENT_LIMITS.maxFilesPerApplication) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_DOCUMENT_LIMIT);
    }

    const documents =
      await organizationApplicationRepository.findDocumentsByIds(documentIds);
    if (documents.length !== documentIds.length) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_DOCUMENT_NOT_FOUND);
    }
    for (const document of documents) {
      if (document.submissionEmail !== submissionEmail) {
        throw new HttpError(HTTP_STATUS.ORGANIZATION_DOCUMENT_NOT_FOUND);
      }
    }
    return documents.map((d) => d.id);
  }

  /** `ORG-XXXXXXXX`; retried on the (unlikely) unique clash. */
  private async createWithUniqueCode(
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

  toPublicResponse(
    row: {
      id: string;
      code: string;
      orgType: string;
      status: string;
      profile: Prisma.JsonValue;
      channels: Prisma.JsonValue;
      reviewNote: string | null;
      rejectReason: string | null;
      organizationId: string | null;
      createdAt: Date;
      reviewedAt: Date | null;
    },
    documents: DocumentRow[],
  ): ApplicationPublicResponse {
    return {
      id: row.id,
      code: row.code,
      orgType: row.orgType,
      status: row.status,
      profile: row.profile,
      channels: row.channels,
      documents: documents.map((d) => this.toDocumentResponse(d)),
      reviewNote: row.reviewNote,
      rejectReason: row.rejectReason,
      organizationId: row.organizationId,
      submittedAt: row.createdAt,
      reviewedAt: row.reviewedAt,
    };
  }
}

export const organizationApplicationService =
  new OrganizationApplicationService();
