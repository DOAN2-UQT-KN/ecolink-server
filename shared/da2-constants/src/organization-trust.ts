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

/**
 * Lifecycle of an application.
 *
 * `PENDING_REVIEW` is only reachable once every owner candidate has confirmed, so the admin
 * queue never shows an application someone has not agreed to. That rule lives in the state
 * machine, not in an `if` inside the approve handler.
 */
export enum ApplicationStatus {
  DRAFT = "DRAFT",
  /** Submitted; waiting for every owner candidate to confirm by email. */
  AWAITING_OWNER_CONFIRMATION = "AWAITING_OWNER_CONFIRMATION",
  /** All owners confirmed; in the admin queue. */
  PENDING_REVIEW = "PENDING_REVIEW",
  /** An admin asked for changes, or an owner declined / let the invitation expire. */
  NEEDS_REVISION = "NEEDS_REVISION",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
  WITHDRAWN = "WITHDRAWN",
}

/** Statuses that still occupy the "one open application per submitter email" slot. */
export const OPEN_APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  ApplicationStatus.DRAFT,
  ApplicationStatus.AWAITING_OWNER_CONFIRMATION,
  ApplicationStatus.PENDING_REVIEW,
  ApplicationStatus.NEEDS_REVISION,
] as const;

export function isOpenApplicationStatus(status: string): boolean {
  return (OPEN_APPLICATION_STATUSES as readonly string[]).includes(status);
}

/** Statuses in which the submitter may still edit the application. */
export const EDITABLE_APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  ApplicationStatus.DRAFT,
  ApplicationStatus.NEEDS_REVISION,
] as const;

/** `NEW_ORG` creates an organization; `ADD_OWNER` (phase 2) adds owners to an existing one. */
export enum ApplicationType {
  NEW_ORG = "NEW_ORG",
  ADD_OWNER = "ADD_OWNER",
}

/** Where one owner candidate stands on their confirmation email. */
export enum OwnerCandidateStatus {
  PENDING = "PENDING",
  CONFIRMED = "CONFIRMED",
  DECLINED = "DECLINED",
  EXPIRED = "EXPIRED",
}

/**
 * Role of a user inside one organization (`organization_members.role`). A `User` has no
 * global "organization account" flag: being an organization's owner is just a membership.
 */
export enum OrgMemberRole {
  LEGAL_REPRESENTATIVE = "LEGAL_REPRESENTATIVE",
  OWNER = "OWNER",
  ADMIN = "ADMIN",
  CAMPAIGN_MANAGER = "CAMPAIGN_MANAGER",
  MEMBER = "MEMBER",
}

/** Roles that count as "owner": they manage the organization and count toward the 3-org cap. */
export const OWNER_ROLES: readonly OrgMemberRole[] = [
  OrgMemberRole.LEGAL_REPRESENTATIVE,
  OrgMemberRole.OWNER,
] as const;

export function isOwnerRole(role: string | null | undefined): boolean {
  return (OWNER_ROLES as readonly string[]).includes(role ?? "");
}

/** Where a membership came from, kept for tracing. */
export enum MembershipSource {
  APPLICATION_APPROVAL = "APPLICATION_APPROVAL",
  JOIN_REQUEST = "JOIN_REQUEST",
  INVITATION = "INVITATION",
  INTERNAL = "INTERNAL",
}

/**
 * A member invitation. `PENDING_APPROVAL` when the inviter cannot approve members themselves;
 * `SENT` once approved (the invitee holds a token); then the invitee answers.
 */
export enum InvitationStatus {
  PENDING_APPROVAL = "PENDING_APPROVAL",
  SENT = "SENT",
  ACCEPTED = "ACCEPTED",
  DECLINED = "DECLINED",
  REJECTED = "REJECTED",
  CANCELLED = "CANCELLED",
  EXPIRED = "EXPIRED",
}

/** Invitations still waiting on someone. */
export const OPEN_INVITATION_STATUSES: readonly InvitationStatus[] = [
  InvitationStatus.PENDING_APPROVAL,
  InvitationStatus.SENT,
] as const;

/** How long an approved invitation link stays valid. */
export const ORG_INVITATION_TTL_DAYS = 7;

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
  OWNER_CONFIRMED = "OWNER_CONFIRMED",
  OWNER_DECLINED = "OWNER_DECLINED",
  OWNER_EXPIRED = "OWNER_EXPIRED",
  OWNER_CANDIDATE_REMOVED = "OWNER_CANDIDATE_REMOVED",
  OWNER_CONFIRMATIONS_RESET = "OWNER_CONFIRMATIONS_RESET",
  OWNER_INVITE_RESENT = "OWNER_INVITE_RESENT",
  READY_FOR_REVIEW = "READY_FOR_REVIEW",
  OWNER_ATTACHED = "OWNER_ATTACHED",
  /** The submitter saved the draft by hand and was mailed a "draft updated" notice. */
  DRAFT_UPDATE_NOTIFIED = "DRAFT_UPDATE_NOTIFIED",
}

/** Severity of an organization violation (writer lands in a later phase). */
export enum ViolationSeverity {
  MINOR = "MINOR",
  MAJOR = "MAJOR",
}

/** How many organizations one user may be an owner (or legal representative) of. */
export const OWNER_ORG_LIMIT = 3;

/** Owner candidates per application; matches the 5-document limit. */
export const MAX_OWNERS_PER_APPLICATION = 5;

/** How long an owner candidate has to answer the confirmation email. */
export const OWNER_CONFIRM_TTL_DAYS = 14;

/**
 * Minimum gap between two confirmation emails to the same candidate. There is no cap on the
 * number of resends; this gap is what keeps the public resend endpoint from flooding someone
 * else's inbox.
 */
export const OWNER_CONFIRM_RESEND_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Anti-spam: an email may be a pending candidate on at most this many other open
 * applications. Without it anyone could flood a mailbox by listing it on junk applications.
 */
export const MAX_PENDING_INVITES_PER_EMAIL = 2;

/** At most one "draft updated" email per application in this window, however often it is saved. */
export const DRAFT_UPDATE_NOTICE_COOLDOWN_MS = 60 * 60 * 1000;

/** How long a lane B verification stays valid before it must be re-assessed. */
export const LANE_B_VERIFICATION_VALID_DAYS = 365;

/** Upload constraints for application documents. */
export const APPLICATION_DOCUMENT_LIMITS = {
  maxFilesPerApplication: 5,
  maxFileSizeBytes: 10 * 1024 * 1024,
  allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"],
} as const;
