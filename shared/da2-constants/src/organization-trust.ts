/**
 * Vocabulary for the organization application / trust pipeline.
 *
 * These are stored as short strings (not numeric `GlobalStatus`) because they are
 * independent axes that admins and the client read directly: an organization can be
 * `status = ACTIVE` while `kycStatus = EXPIRED` and `trustTier = NONE` at the same time.
 */

/** Kind of legal entity behind an organization. Declared by the applicant, confirmed by an admin. */
export enum OrgType {
  GOV = "GOV",
  SCHOOL = "SCHOOL",
  CLUB = "CLUB",
  NGO = "NGO",
  SOCIAL_ENTERPRISE = "SOCIAL_ENTERPRISE",
}

/**
 * Review lane. `A` (fast-track) is for government bodies / schools identified by an official
 * domain; `B` is the standard lane requiring legal documents and an activity history.
 * Always `null` at submit time — only an admin sets it, see `documentsWaived`.
 */
export enum ApplicationLane {
  A = "A",
  B = "B",
}

/** Legal-paperwork verdict, owned by admins through an application decision. */
export enum KycStatus {
  NOT_SUBMITTED = "NOT_SUBMITTED",
  APPROVED = "APPROVED",
  EXPIRED = "EXPIRED",
  REVOKED = "REVOKED",
}

/**
 * Privilege level ("Blue Tick"). `APPROVED` paperwork does not imply `VERIFIED`:
 * lane B organizations stay at `NONE` until they also clear the activity criteria.
 */
export enum TrustTier {
  NONE = "NONE",
  BASIC = "BASIC",
  VERIFIED = "VERIFIED",
}

/** Lifecycle of an application. `APPROVED` is what triggers organization provisioning. */
export enum ApplicationStatus {
  DRAFT = "DRAFT",
  SUBMITTED = "SUBMITTED",
  UNDER_REVIEW = "UNDER_REVIEW",
  NEEDS_MORE_INFO = "NEEDS_MORE_INFO",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
  WITHDRAWN = "WITHDRAWN",
}

/** Statuses that still occupy the "one open application per contact email" slot. */
export const OPEN_APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  ApplicationStatus.SUBMITTED,
  ApplicationStatus.UNDER_REVIEW,
  ApplicationStatus.NEEDS_MORE_INFO,
] as const;

export function isOpenApplicationStatus(status: string): boolean {
  return (OPEN_APPLICATION_STATUSES as readonly string[]).includes(status);
}

/** Legal documents an applicant may attach. Stored in a private bucket, never public. */
export enum ApplicationDocType {
  ESTABLISHMENT_DECISION = "ESTABLISHMENT_DECISION",
  BUSINESS_LICENSE = "BUSINESS_LICENSE",
  REP_ID_CARD = "REP_ID_CARD",
  OTHER = "OTHER",
}

/** Public contact channels shown on the organization page. */
export enum OrganizationChannelType {
  FACEBOOK_PAGE = "FACEBOOK_PAGE",
  WEBSITE = "WEBSITE",
  ZALO_OA = "ZALO_OA",
}

/** Identity document the legal representative is identified by. Only a hash + last 4 are stored. */
export enum LegalRepIdType {
  CCCD = "CCCD",
  MSSV = "MSSV",
  PASSPORT = "PASSPORT",
  OTHER = "OTHER",
}

/** Audit trail entries written for every application state change and every document view. */
export enum ApplicationEventType {
  SUBMITTED = "SUBMITTED",
  RESUBMITTED = "RESUBMITTED",
  WITHDRAWN = "WITHDRAWN",
  CLAIMED = "CLAIMED",
  INFO_REQUESTED = "INFO_REQUESTED",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
  DOCUMENTS_WAIVED = "DOCUMENTS_WAIVED",
  DOCUMENT_VIEWED = "DOCUMENT_VIEWED",
  ACCOUNT_PROVISIONED = "ACCOUNT_PROVISIONED",
}

/** Severity of an organization violation (writer lands in a later phase). */
export enum ViolationSeverity {
  MINOR = "MINOR",
  MAJOR = "MAJOR",
}

/** Default cap on how many organizations one legal representative may stand for. */
export const DEFAULT_LEGAL_REP_ORG_LIMIT = 3;

/** How long a lane B verification stays valid before it must be re-assessed. */
export const LANE_B_VERIFICATION_VALID_DAYS = 365;

/** Upload constraints for application documents. */
export const APPLICATION_DOCUMENT_LIMITS = {
  maxFilesPerApplication: 5,
  maxFileSizeBytes: 10 * 1024 * 1024,
  allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"],
} as const;
