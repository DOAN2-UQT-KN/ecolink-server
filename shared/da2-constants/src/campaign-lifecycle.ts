import { GlobalStatus } from "./global-status";

/**
 * Campaign lifecycle (docs: Ecolink – Đặc tả luồng chiến dịch, giai đoạn 1–2).
 * The column stays a `GlobalStatus` int; these names map the spec's states onto it.
 * Approval leads to UPCOMING; the lifecycle job moves it to ACTIVE when the first shift starts.
 */
export const CampaignStatus = {
  DRAFT: GlobalStatus._STATUS_DRAFT,
  PENDING_REVIEW: GlobalStatus._STATUS_PENDING,
  NEEDS_REVISION: GlobalStatus._STATUS_RETURNED,
  /** Approved, recruiting; nothing has started yet. */
  UPCOMING: GlobalStatus._STATUS_UPCOMING,
  ACTIVE: GlobalStatus._STATUS_ACTIVE,
  PENDING_COMPLETION: GlobalStatus._STATUS_WAITING_CONFIRMED,
  /** Legacy completion state, still accepted by mark-done. */
  LEGACY_IN_REVIEW: GlobalStatus._STATUS_INREVIEW,
  COMPLETED: GlobalStatus._STATUS_COMPLETED,
  BLOCKED: GlobalStatus._STATUS_INACTIVE,
  EXPIRED: GlobalStatus._STATUS_OBSOLETE,
  /** Stopped before approval, e.g. because its organization was locked. */
  CANCELLED: GlobalStatus._STATUS_CANCELED,
} as const;

export type CampaignStatusValue =
  (typeof CampaignStatus)[keyof typeof CampaignStatus];

/** Statuses that hold a lock on their reports (waste points). */
export const CAMPAIGN_REPORT_LOCKING_STATUSES: readonly number[] = [
  CampaignStatus.PENDING_REVIEW,
  CampaignStatus.NEEDS_REVISION,
  CampaignStatus.UPCOMING,
  CampaignStatus.ACTIVE,
  CampaignStatus.PENDING_COMPLETION,
  CampaignStatus.LEGACY_IN_REVIEW,
];

/** Statuses where the campaign content may still be edited freely (before approval). */
export const CAMPAIGN_PRE_APPROVAL_STATUSES: readonly number[] = [
  CampaignStatus.DRAFT,
  CampaignStatus.PENDING_REVIEW,
  CampaignStatus.NEEDS_REVISION,
];

/** Statuses anyone can see; the others are visible to the campaign's managers and admins only. */
export const CAMPAIGN_PUBLIC_STATUSES: readonly number[] = [
  CampaignStatus.UPCOMING,
  CampaignStatus.ACTIVE,
  CampaignStatus.PENDING_COMPLETION,
  CampaignStatus.LEGACY_IN_REVIEW,
  CampaignStatus.COMPLETED,
];

/** Statuses a campaign may be deleted in (a completed campaign never is). */
export const CAMPAIGN_DELETABLE_STATUSES: readonly number[] = [
  CampaignStatus.DRAFT,
  CampaignStatus.PENDING_REVIEW,
  CampaignStatus.NEEDS_REVISION,
  CampaignStatus.BLOCKED,
  CampaignStatus.EXPIRED,
];

/** Statuses that count as "open" for the unverified-organization limit. */
export const CAMPAIGN_OPEN_STATUSES: readonly number[] = [
  CampaignStatus.UPCOMING,
  CampaignStatus.ACTIVE,
  CampaignStatus.PENDING_COMPLETION,
  CampaignStatus.LEGACY_IN_REVIEW,
];

/** Statuses volunteers may register for shifts in (spec 3.1). */
export const CAMPAIGN_REGISTRABLE_STATUSES: readonly number[] = [
  CampaignStatus.UPCOMING,
  CampaignStatus.ACTIVE,
];

/** Statuses that count toward the per-organization review queue limit. */
export const CAMPAIGN_IN_REVIEW_QUEUE_STATUSES: readonly number[] = [
  CampaignStatus.PENDING_REVIEW,
  CampaignStatus.NEEDS_REVISION,
];

/** Tunables; starting values from the spec, meant to be adjusted after the pilot. */
export const CAMPAIGN_MIN_LEAD_HOURS = 48;
export const CAMPAIGN_MAX_HOURS_PER_DAY = 12;
export const CAMPAIGN_TITLE_MIN_LENGTH = 10;
export const CAMPAIGN_TITLE_MAX_LENGTH = 120;
export const CAMPAIGN_DESCRIPTION_MIN_LENGTH = 100;
export const CAMPAIGN_PENDING_LIMIT_PER_ORG = 3;
export const CAMPAIGN_UNVERIFIED_MAX_OPEN = 2;
export const CAMPAIGN_UNVERIFIED_MAX_DIFFICULTY = 1;
export const CAMPAIGN_REVISION_HOLD_DAYS = 7;
export const CAMPAIGN_DRAFT_TTL_DAYS = 30;
/** A campaign runs on 1–7 days, all within this many days from the first one. */
export const CAMPAIGN_DAY_MAX = 7;
export const CAMPAIGN_DAY_SPAN_DAYS = 14;
export const CAMPAIGN_MEETING_POINT_MAX = 5;
/**
 * Spec: a campaign covers at least one approved waste point. Temporarily off on request, so a
 * campaign can be sent for review without any; set back to `true` to enforce the spec again.
 */
export const CAMPAIGN_REPORTS_REQUIRED = false;
export const CAMPAIGN_MEETING_POINT_MAX_DISTANCE_KM = 5;
/** Difficulty level from which volunteers must be adults by default. */
/** Difficulty levels a draft may hold; the tier itself (limits, points) is read from reward-service on submit. */
export const CAMPAIGN_DIFFICULTY_MIN = 1;
export const CAMPAIGN_DIFFICULTY_MAX = 4;
export const CAMPAIGN_HIGH_DIFFICULTY_LEVEL = 3;
export const CAMPAIGN_HIGH_DIFFICULTY_MIN_AGE = 18;
export const CAMPAIGN_REVIEW_REASON_MAX_LENGTH = 5000;
/** Leaving a shift later than this many hours before it starts is recorded as a late leave. */
export const CAMPAIGN_FREE_LEAVE_HOURS = 24;
/** Absences in this window, from this count on, raise a warning when registering. */
export const CAMPAIGN_ABSENCE_WINDOW_DAYS = 90;
export const CAMPAIGN_ABSENCE_WARN_COUNT = 3;
/** Local hour (Asia/Ho_Chi_Minh) after which managers get the daily registration digest. */
export const CAMPAIGN_REGISTRATION_DIGEST_HOUR = 20;

/** Warnings returned with a shift registration; none of them blocks it (spec 3.1). */
export const CampaignRegistrationWarning = {
  OVERLAP: "OVERLAP",
  MANY_ABSENCES: "MANY_ABSENCES",
  OVER_MAX: "OVER_MAX",
} as const;

export type CampaignRegistrationWarningValue =
  (typeof CampaignRegistrationWarning)[keyof typeof CampaignRegistrationWarning];

/** Optional participation conditions stored on `campaigns.requirements`. */
export interface CampaignRequirements {
  minAge?: number | null;
  skills?: string[];
  bringOwnTools?: boolean;
}

/** Why the "create campaign" button is disabled (or hidden, for `NO_PERMISSION`). */
export const CampaignCreateBlockReason = {
  NO_PERMISSION: "NO_PERMISSION",
  ORG_LOCKED: "ORG_LOCKED",
  REVIEW_QUEUE_FULL: "REVIEW_QUEUE_FULL",
  UNVERIFIED_OPEN_LIMIT: "UNVERIFIED_OPEN_LIMIT",
} as const;

export type CampaignCreateBlockReasonValue =
  (typeof CampaignCreateBlockReason)[keyof typeof CampaignCreateBlockReason];
