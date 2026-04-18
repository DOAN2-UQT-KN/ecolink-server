/**
 * Ledger row `type` (extend as new earning rules are added).
 * Stored as VARCHAR in DB — keep values stable for API/clients.
 */
export const GreenPointTransactionType = {
  CAMPAIGN_COMPLETION: "CAMPAIGN_COMPLETION",
  UPVOTE: "UPVOTE",
  REFERRAL: "REFERRAL",
  GIFT_REDEEM: "GIFT_REDEEM",
} as const;

export type GreenPointTransactionTypeName =
  (typeof GreenPointTransactionType)[keyof typeof GreenPointTransactionType];

/**
 * What `resource_id` refers to (campaign, report, user for referral target, etc.).
 */
export const GreenPointResourceType = {
  CAMPAIGN: "CAMPAIGN",
  REPORT: "REPORT",
  USER: "USER",
  GIFT_REDEMPTION: "GIFT_REDEMPTION",
} as const;

export type GreenPointResourceTypeName =
  (typeof GreenPointResourceType)[keyof typeof GreenPointResourceType];
