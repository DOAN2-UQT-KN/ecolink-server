/** SQS envelope `jobType` for campaign-completion batch credits. */
export const CAMPAIGN_COMPLETION_JOB_TYPE =
  "CAMPAIGN_COMPLETION_GREEN_POINTS" as const;

/** @deprecated Use CAMPAIGN_COMPLETION_JOB_TYPE */
export const GREEN_POINT_JOB_TYPE = CAMPAIGN_COMPLETION_JOB_TYPE;

/** SQS envelope `jobType` for a single report completion credit. */
export const REPORT_COMPLETION_GREEN_POINT_JOB_TYPE =
  "REPORT_COMPLETION_GREEN_POINTS" as const;

/** SQS envelope `jobType` for evaluating report vote thresholds for creator bonus credits. */
export const REPORT_VOTE_MILESTONE_GREEN_POINT_JOB_TYPE =
  "REPORT_VOTE_MILESTONE_GREEN_POINTS" as const;

/** Allowed `type` values for POST /internal/v1/green-points/enqueue (keep in sync with factory). */
export const KNOWN_GREEN_POINT_JOB_TYPES = [
  CAMPAIGN_COMPLETION_JOB_TYPE,
  REPORT_COMPLETION_GREEN_POINT_JOB_TYPE,
  REPORT_VOTE_MILESTONE_GREEN_POINT_JOB_TYPE,
] as const;

export type KnownGreenPointJobType =
  (typeof KNOWN_GREEN_POINT_JOB_TYPES)[number];

/** Generic internal enqueue body: discriminates strategy via `type`. */
export interface GreenPointEnqueueRequestBody {
  type: KnownGreenPointJobType;
  payload: unknown;
}

/**
 * Campaign completion facts: who attended how many shifts. Points come from the active point
 * rules at credit time (spec 013 FR-010, FR-012).
 */
export interface CampaignCompletionGreenPointsPayload {
  campaignId: string;
  participants: {
    userId: string;
    /** Shifts attended long enough; >= 1. */
    eligibleShifts: number;
    /** Shifts registered and not left; >= 0. */
    registeredShifts: number;
  }[];
}

/**
 * Pre-refactor shape with points already computed by incident-service. Accepted for one release
 * so events queued during the deploy are still credited (FR-014); remove in wave C.
 */
export interface LegacyCampaignCompletionGreenPointsPayload {
  campaignId: string;
  credits: { userId: string; points: number }[];
}

/** Report creator rewarded when an admin marks the report done; points come from the rules. */
export interface ReportCompletionGreenPointsPayload {
  reportId: string;
  userId: string;
}

/**
 * Report creator earns bonus points when report reaches configured vote thresholds.
 * Worker will attempt to credit for every threshold <= voteCount; idempotency prevents duplicates.
 */
export interface ReportVoteMilestoneGreenPointsPayload {
  reportId: string;
  reportCreatorUserId: string;
  voteCount: number;
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
