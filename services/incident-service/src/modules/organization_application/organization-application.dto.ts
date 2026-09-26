/**
 * Request / response shapes for the organization application pipeline.
 *
 * JSON keys arrive snake_case and leave snake_case; `camelCaseRequestBody` /
 * `snakeCaseResponseBody` translate at the edges, so everything here is camelCase.
 */

/* -------------------------------------------------------------------------- */
/* P0 — email ownership                                                        */
/* -------------------------------------------------------------------------- */

/** Body for POST /api/v1/organization-applications/email-otp. */
export interface RequestApplicationOtpBody {
  email: string;
}

export interface RequestApplicationOtpResponse {
  /** Always true — we never reveal whether the address already has an open application. */
  sent: boolean;
  expiresAt: string;
}

/** Body for POST /api/v1/organization-applications/email-otp/verify. */
export interface VerifyApplicationOtpBody {
  email: string;
  otp: string;
}

export interface VerifyApplicationOtpResponse {
  /** The draft opened (or reopened) for this mailbox. */
  applicationId: string;
  /** Tracking-link token (180 days); sent back as `?token=` on every applicant endpoint. */
  trackingToken: string;
  /** True when an open application already existed and was handed back. */
  resumed: boolean;
}

/* -------------------------------------------------------------------------- */
/* P1 — documents                                                              */
/* -------------------------------------------------------------------------- */

/** Body for POST /api/v1/organization-applications/:id/documents/presign. */
export interface PresignApplicationDocumentBody {
  /** `ApplicationDocType`. */
  docType: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface PresignApplicationDocumentResponse {
  documentId: string;
  uploadUrl: string;
  /** Form fields that must be posted alongside the file, exactly as given. */
  fields: Record<string, string>;
  expiresAt: string;
}

/* -------------------------------------------------------------------------- */
/* P2 — submission                                                             */
/* -------------------------------------------------------------------------- */

export interface ApplicationProfileInput {
  name: string;
  /** Public contact address of the organization. Defaults to the submitter's email. */
  contactEmail?: string | null;
  logoUrl: string;
  backgroundUrl?: string | null;
  address?: string | null;
  /** Point picked on the map; copied onto the organization when the application is approved. */
  latitude?: number | null;
  longitude?: number | null;
  description?: string | null;
}

export interface ApplicationChannelInput {
  /** `OrganizationChannelType`. */
  type: string;
  url: string;
  isPrimary?: boolean;
}

/**
 * KYC for the owner marked `isLegalRep`. Review-only: never returned by a public endpoint
 * and never copied onto the organization; `idNumber` is hashed on arrival and discarded.
 * Name and email come from the owner row itself.
 */
export interface LegalRepresentativeInput {
  idType?: string | null;
  /** Omit to keep the number saved earlier. */
  idNumber?: string | null;
  phone?: string | null;
  position?: string | null;
}

/** One row of the owner list. */
export interface OwnerCandidateInput {
  email: string;
  fullName: string;
  isLegalRep?: boolean;
  /** Optional pointer to an uploaded document (e.g. ID card) for this person. */
  nationalIdDocumentId?: string | null;
}

/**
 * Body for PUT /api/v1/organization-applications/:id — saves the draft (DRAFT or
 * NEEDS_REVISION). Every field is optional; only what is sent is changed. Full validation
 * happens on submit.
 */
export interface SaveApplicationBody {
  /** `OrgType`. */
  orgType?: string;
  profile?: Partial<ApplicationProfileInput>;
  channels?: ApplicationChannelInput[];
  legalRepresentative?: LegalRepresentativeInput;
  /** The full owner list; rows missing from it are marked removed (never deleted). */
  owners?: OwnerCandidateInput[];
  /** Uploaded documents to attach. */
  documentIds?: string[];
  /** Attached documents to drop (soft-deleted). */
  removeDocumentIds?: string[];
  /** Consent to processing personal data; required before submitting. */
  consent?: boolean;
  /**
   * True only when the submitter pressed "Save draft" (not on "Continue"): mail them a
   * "draft updated" notice, at most once an hour per application.
   */
  notifySubmitter?: boolean;
}

/** Body for POST /api/v1/organization-applications/:id/submit. */
export interface SubmitApplicationBody {
  consent?: boolean;
}

/** Request metadata captured as evidence when someone confirms. */
export interface ConfirmationRequestMeta {
  ip: string | null;
  userAgent: string | null;
}

/* -------------------------------------------------------------------------- */
/* P3 — admin review                                                           */
/* -------------------------------------------------------------------------- */

/** Body for PUT /api/v1/admin/organization-applications/:id/request-info. */
export interface RequestMoreInfoBody {
  message: string;
}

/** Body for PUT /api/v1/admin/organization-applications/:id/decision. */
export interface ApplicationDecisionBody {
  /** `APPROVE` | `REJECT`. */
  decision: string;
  /** `ApplicationLane`; required when approving. */
  lane?: string;
  documentsWaived?: boolean;
  documentsWaivedReason?: string | null;
  rejectReason?: string | null;
  /** Defaults to true for lane A, false for lane B. */
  grantBlueTick?: boolean;
}

export interface AdminApplicationListQuery {
  status?: string;
  orgType?: string;
  lane?: string;
  q?: string;
  page?: number;
  limit?: number;
}

/* -------------------------------------------------------------------------- */
/* Responses                                                                   */
/* -------------------------------------------------------------------------- */

export interface ApplicationDocumentResponse {
  id: string;
  docType: string;
  fileName: string | null;
  mimeType: string;
  sizeBytes: number;
  purgedAt: Date | null;
  createdAt: Date;
}

export interface ApplicationEventResponse {
  id: string;
  eventType: string;
  actorId: string | null;
  /** Display name of the actor from identity-service; null for the applicant or on lookup failure. */
  actorName: string | null;
  payload: unknown;
  createdAt: Date;
}

/** Legal representative KYC. The raw ID number is never available. */
export interface LegalRepresentativeResponse {
  fullName: string | null;
  email: string | null;
  idType: string | null;
  idLast4: string | null;
  phone: string | null;
  position: string | null;
}

/** One owner candidate as the submitter sees it on the tracking page. */
export interface OwnerCandidateResponse {
  id: string;
  email: string;
  fullName: string;
  isLegalRep: boolean;
  nationalIdDocumentId: string | null;
  /** `OwnerCandidateStatus`. */
  status: string;
  isSubmitter: boolean;
  respondedAt: Date | null;
  expiresAt: Date | null;
  sentAt: Date | null;
  sentCount: number;
  /** Earliest time the submitter may resend; null when a resend is not possible at all. */
  nextResendAt: Date | null;
  declineReason: string | null;
}

/** Extra evidence an admin sees for each owner. */
export interface AdminOwnerCandidateResponse extends OwnerCandidateResponse {
  confirmIp: string | null;
  confirmUa: string | null;
  resolvedUserId: string | null;
  /** identity-service account for this email, if any (null also when identity is down). */
  account: {
    userId: string;
    status: number;
    createdAt: Date;
  } | null;
  /** Organizations this person already owns. */
  activeOwnerOrgCount: number;
  /** True when another owner confirmed from the same IP within 5 minutes. */
  sameIpCluster: boolean;
}

/** What the applicant sees when tracking their own submission. */
export interface ApplicationPublicResponse {
  id: string;
  code: string;
  type: string;
  orgType: string | null;
  status: string;
  submitterEmail: string;
  contactEmail: string | null;
  profile: unknown;
  channels: unknown;
  documents: ApplicationDocumentResponse[];
  owners: OwnerCandidateResponse[];
  confirmedCount: number;
  totalOwners: number;
  legalRepresentative: LegalRepresentativeResponse;
  /** Message from the reviewer (revision request) or the system (owner declined / expired). */
  reviewNote: string | null;
  rejectReason: string | null;
  organizationId: string | null;
  consentedAt: Date | null;
  createdAt: Date;
  submittedAt: Date | null;
  reviewedAt: Date | null;
}

/** Everything an admin needs, including review-only fields. */
export interface ApplicationAdminResponse
  extends Omit<ApplicationPublicResponse, "owners"> {
  owners: AdminOwnerCandidateResponse[];
  lane: string | null;
  documentsWaived: boolean;
  documentsWaivedReason: string | null;
  submittedByUserId: string | null;
  emailVerifiedAt: Date | null;
  reviewerId: string | null;
  claimedAt: Date | null;
  purgedAt: Date | null;
  events: ApplicationEventResponse[];
}

/** What the public confirmation page shows to one candidate. */
export interface OwnerConfirmationSummaryResponse {
  /** `OwnerCandidateStatus` of this candidate. */
  status: string;
  applicationStatus: string;
  /** False when the application no longer waits on confirmations (withdrawn, decided, ...). */
  active: boolean;
  expired: boolean;
  expiresAt: Date | null;
  applicationCode: string;
  /** `ApplicationType`: `ADD_OWNER` means joining an existing organization as owner. */
  applicationType: string;
  organization: {
    name: string | null;
    orgType: string | null;
    address: string | null;
    logoUrl: string | null;
    description: string | null;
  };
  submitterEmail: string;
  candidate: { email: string; fullName: string; isLegalRep: boolean };
  otherOwners: { email: string; fullName: string; isLegalRep: boolean }[];
  /** A signed-in user whose email differs from the candidate's; the page warns them. */
  sessionEmailMismatch: boolean;
}

export interface PaginatedApplicationsResponse {
  applications: ApplicationAdminResponse[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/* -------------------------------------------------------------------------- */
/* OpenAPI envelope data types                                                 */
/* -------------------------------------------------------------------------- */

export interface ApplicationOneEnvelopeData {
  application: ApplicationPublicResponse;
}

export interface ApplicationAdminOneEnvelopeData {
  application: ApplicationAdminResponse;
}

export type PaginatedApplicationsEnvelopeData = PaginatedApplicationsResponse;
