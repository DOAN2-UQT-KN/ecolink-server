/**
 * Result verification of a campaign (spec "Cơ chế xác thực kết quả chiến dịch", version 2): Layer 1
 * grades each trash point declared cleaned from the EXIF and pin of its before / after photos; a
 * meeting point's Layer 1 is the worst of its cleaned trash points. Layers 2 (the original
 * reporters) and 3 (the weighted community vote in a 72-hour window) vote per meeting point. The
 * system decides each meeting point and then the campaign.
 */

/**
 * Outcome of one Layer 1 check, of a photo, of a trash point (the worst of its photos) and of a
 * meeting point (the worst of its cleaned trash points).
 */
export const RESULT_CHECK_LEVEL = {
  PASS: "pass",
  WARN: "warn",
  FAIL: "fail",
} as const;
export type ResultCheckLevelValue = (typeof RESULT_CHECK_LEVEL)[keyof typeof RESULT_CHECK_LEVEL];

/** Side of a result photo. */
export const RESULT_PHOTO_SIDE = { BEFORE: "before", AFTER: "after" } as const;
export type ResultPhotoSideValue = (typeof RESULT_PHOTO_SIDE)[keyof typeof RESULT_PHOTO_SIDE];

/** Live camera: where the shot was taken vs. the trash point (not used by the web yet). */
export const RESULT_PHOTO_LIVE_RADIUS_M = 30;
/** Library photo: EXIF time at most this long before the upload, and never after it. */
export const RESULT_PHOTO_MAX_AGE_HOURS = 48;
/** Library photo: EXIF GPS vs. the pin, and the pin vs. the trash point. */
export const RESULT_PHOTO_EXIF_PIN_MAX_M = 100;
export const RESULT_PHOTO_PIN_POINT_MAX_M = 100;
/** Upload limits of a result photo (the original file, so the server can read its EXIF). */
export const RESULT_PHOTO_MAX_BYTES = 15 * 1024 * 1024;
export const RESULT_PHOTO_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
] as const;

/** Layer 1 findings of a trash point (`layer1.issues[].code`). */
export const RESULT_LAYER1_ISSUE = {
  /** One of the point's photos failed a check (see the photo's own checks). */
  PHOTO_FAIL: "photo_fail",
  /** One of the point's photos has a warning (no EXIF time or GPS). */
  PHOTO_WARN: "photo_warn",
  /** Saved before photos were checked: counted as a warning. */
  LEGACY_PHOTO: "legacy_photo",
  /** A photo "before" was taken at the same time as or after a photo "after". */
  BEFORE_NOT_EARLIER: "before_not_earlier",
  /** A photo "before" and a photo "after" are the same file. */
  BEFORE_AFTER_SAME: "before_after_same",
  /** The same file was used for another trash point or another campaign. */
  HASH_REUSED: "hash_reused",
} as const;
export type ResultLayer1IssueValue = (typeof RESULT_LAYER1_ISSUE)[keyof typeof RESULT_LAYER1_ISSUE];

/** Status of a meeting point's verification round. */
export const MEETING_POINT_STATUS = {
  VOTING: "voting",
  VERIFIED: "verified",
  FLAGGED: "flagged",
  REJECTED: "rejected",
} as const;
export type MeetingPointStatusValue = (typeof MEETING_POINT_STATUS)[keyof typeof MEETING_POINT_STATUS];

/** Why a meeting point was decided (`decision_code`). */
export const MEETING_POINT_DECISION = {
  /** Score reached `MEETING_POINT_VERIFIED_SCORE`. */
  SCORE: "score",
  /** Window closed, no downvote, Layer 1 passed. */
  LAYER1_PASS: "layer1_pass",
  /** Window closed, no downvote, Layer 1 failed. */
  LAYER1_FAIL: "layer1_fail",
  /** Flagged and the admin did not decide in `MEETING_POINT_FLAG_DEADLINE_HOURS`. */
  FLAG_TIMEOUT: "flag_timeout",
  /** The admin decided a flagged meeting point. */
  ADMIN: "admin",
} as const;
export type MeetingPointDecisionValue = (typeof MEETING_POINT_DECISION)[keyof typeof MEETING_POINT_DECISION];

/** Score ≥ this: verified at once. */
export const MEETING_POINT_VERIFIED_SCORE = 15;
/** At least one downvote and score ≤ this: flagged for the admin. */
export const MEETING_POINT_FLAG_SCORE = 3;
/** Voting window from marking the campaign done. */
export const MEETING_POINT_VOTING_HOURS = 72;
/** The admin decides a flagged meeting point within this, else it is rejected. */
export const MEETING_POINT_FLAG_DEADLINE_HOURS = 48;
/** The original reporter who has not voted yet is reminded once after this. */
export const MEETING_POINT_REPORTER_REMIND_HOURS = 24;

/** Voter's live GPS this close to the meeting point or one of its trash points: "on site". */
export const MEETING_POINT_VOTE_ON_SITE_M = 30;
/** Live GPS or saved location this close: "nearby" (same radius as the campaign invitations). */
export const MEETING_POINT_VOTE_NEARBY_M = 5000;
/** Younger accounts (or unverified emails) vote with weight 0. */
export const MEETING_POINT_VOTE_MIN_ACCOUNT_DAYS = 7;
/** New votes per person per rolling 24 hours, across the platform; changing a vote is free. */
export const MEETING_POINT_VOTES_PER_DAY = 20;
/** Note on a vote (a downvote needs a note or a photo, and the trash points not clean). */
export const MEETING_POINT_VOTE_NOTE_MAX = 1000;

export const MEETING_POINT_VOTE_WEIGHT = {
  REPORTER: 10,
  ON_SITE: 3,
  NEARBY: 1,
} as const;

/** Why a vote weighs what it weighs (`weight_reason`). */
export const MEETING_POINT_WEIGHT_REASON = {
  REPORTER: "reporter",
  ON_SITE: "on_site",
  NEARBY: "nearby",
  ZERO_NEW_ACCOUNT: "zero_new_account",
  ZERO_UNVERIFIED: "zero_unverified",
  ZERO_FAR: "zero_far",
} as const;
export type MeetingPointWeightReasonValue =
  (typeof MEETING_POINT_WEIGHT_REASON)[keyof typeof MEETING_POINT_WEIGHT_REASON];

/** Why the viewer may not vote on a meeting point (`cannot_vote_reason`). */
export const MEETING_POINT_CANNOT_VOTE = {
  /** The window is closed, or the meeting point is already verified or rejected. */
  CLOSED: "closed",
  /** Member of the organization running the campaign. */
  ORG_MEMBER: "org_member",
  /** Manager of the campaign. */
  CAMPAIGN_MANAGER: "campaign_manager",
  /** Volunteer who checked in on one of the campaign's shifts. */
  VOLUNTEER: "volunteer",
} as const;
export type MeetingPointCannotVoteValue =
  (typeof MEETING_POINT_CANNOT_VOTE)[keyof typeof MEETING_POINT_CANNOT_VOTE];

/** Why the campaign waits for the admin (`awaiting_admin_reason`). */
export const CAMPAIGN_AWAITING_ADMIN_REASON = {
  /** Rejected `CAMPAIGN_COMPLETION_MAX_REJECTIONS` times already. */
  REJECTION_LIMIT: "rejection_limit",
  /** No trash point was declared cleaned: nothing to vote on. */
  NO_CLEANED_POINTS: "no_cleaned_points",
} as const;
export type CampaignAwaitingAdminReasonValue =
  (typeof CAMPAIGN_AWAITING_ADMIN_REASON)[keyof typeof CAMPAIGN_AWAITING_ADMIN_REASON];
