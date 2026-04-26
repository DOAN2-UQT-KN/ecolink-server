/** SQS envelope `jobType` for campaign-completion batch credits. */
export const CAMPAIGN_COMPLETION_JOB_TYPE =
  "CAMPAIGN_COMPLETION_GREEN_POINTS" as const;

/** @deprecated Use CAMPAIGN_COMPLETION_JOB_TYPE */
export const GREEN_POINT_JOB_TYPE = CAMPAIGN_COMPLETION_JOB_TYPE;

/** SQS envelope `jobType` for a single upvote-related credit. */
export const UPVOTE_ADDING_GREEN_POINT_JOB_TYPE =
  "UPVOTE_ADDING_GREEN_POINTS" as const;

/** SQS envelope `jobType` for a single referral-related credit. */
export const REFERRAL_ADDING_GREEN_POINT_JOB_TYPE =
  "REFERRAL_ADDING_GREEN_POINTS" as const;

/** Allowed `type` values for POST /internal/v1/green-points/enqueue (keep in sync with factory). */
export const KNOWN_GREEN_POINT_JOB_TYPES = [
  CAMPAIGN_COMPLETION_JOB_TYPE,
  UPVOTE_ADDING_GREEN_POINT_JOB_TYPE,
  REFERRAL_ADDING_GREEN_POINT_JOB_TYPE,
] as const;

export type KnownGreenPointJobType =
  (typeof KNOWN_GREEN_POINT_JOB_TYPES)[number];

/** Generic internal enqueue body: discriminates strategy via `type`. */
export interface GreenPointEnqueueRequestBody {
  type: KnownGreenPointJobType;
  payload: unknown;
}

export interface CampaignCompletionGreenPointsPayload {
  campaignId: string;
  credits: { userId: string; points: number }[];
}

/** User receiving points; resource identifies what was upvoted (report, etc.). */
export interface UpvoteAddingGreenPointsPayload {
  userId: string;
  points: number;
  resourceId: string;
  /** e.g. REPORT, CAMPAIGN — must match {@link GreenPointResourceType} values when applicable */
  resourceType: string;
}

/** User receiving referral bonus; resource is the referred user or referral event id. */
export interface ReferralAddingGreenPointsPayload {
  userId: string;
  points: number;
  resourceId: string;
}

export interface GreenPointJobEnvelope {
  version: number;
  jobType: string;
  createdAt: string;
  payload: unknown;
}

export interface ReceivedGreenPointMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
  receiveCount: number;
}
