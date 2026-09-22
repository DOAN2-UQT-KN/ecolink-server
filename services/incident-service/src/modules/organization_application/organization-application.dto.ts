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
  /** Opaque, single-use; sent back as the `x-submission-token` header. */
  submissionToken: string;
  expiresAt: string;
}

/* -------------------------------------------------------------------------- */
/* P1 — documents                                                              */
/* -------------------------------------------------------------------------- */

/** Body for POST /api/v1/organization-applications/documents/presign. */
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
  contactEmail: string;
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
 * Review-only data. Never returned by a public endpoint and never copied onto the
 * organization; `idNumber` is hashed on arrival and the raw value is discarded.
 */
export interface LegalRepresentativeInput {
  fullName: string;
  idType: string;
  idNumber: string;
  phone: string;
  position?: string | null;
  email?: string | null;
}

/** Body for POST /api/v1/organization-applications (needs `x-submission-token`). */
export interface CreateApplicationBody {
  /** `OrgType`. */
  orgType: string;
  profile: ApplicationProfileInput;
  channels: ApplicationChannelInput[];
  legalRepresentative?: LegalRepresentativeInput;
  documentIds?: string[];
  /** Must be true — consent to processing personal data. */
  consent: boolean;
}

/** Body for PUT /api/v1/organization-applications/:id (only while NEEDS_MORE_INFO). */
export interface UpdateApplicationBody
  extends Partial<Omit<CreateApplicationBody, "consent">> {
  /** Token from the tracking link emailed to the applicant. */
  token?: string;
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
  payload: unknown;
  createdAt: Date;
}

/** Legal representative as shown to admins — the raw ID number is never available. */
export interface LegalRepresentativeResponse {
  fullName: string | null;
  idType: string | null;
  idLast4: string | null;
  phone: string | null;
  position: string | null;
  email: string | null;
}

/** What the applicant sees when tracking their own submission. */
export interface ApplicationPublicResponse {
  id: string;
  code: string;
  orgType: string;
  status: string;
  profile: unknown;
  channels: unknown;
  documents: ApplicationDocumentResponse[];
  /** Message from the reviewer when more information is requested. */
  reviewNote: string | null;
  rejectReason: string | null;
  organizationId: string | null;
  submittedAt: Date;
  reviewedAt: Date | null;
}

/** Everything an admin needs, including review-only fields. */
export interface ApplicationAdminResponse extends ApplicationPublicResponse {
  lane: string | null;
  documentsWaived: boolean;
  documentsWaivedReason: string | null;
  contactEmail: string;
  legalRepresentative: LegalRepresentativeResponse;
  submittedByUserId: string | null;
  emailVerifiedAt: Date | null;
  consentedAt: Date | null;
  reviewerId: string | null;
  claimedAt: Date | null;
  accountProvisionedAt: Date | null;
  purgedAt: Date | null;
  events: ApplicationEventResponse[];
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
