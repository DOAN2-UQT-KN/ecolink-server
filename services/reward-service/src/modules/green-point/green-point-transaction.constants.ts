/**
 * Ledger row `type` (extend as new earning rules are added).
 * Stored as VARCHAR in DB — keep values stable for API/clients.
 */
export const GreenPointTransactionType = {
  CAMPAIGN_COMPLETION: "CAMPAIGN_COMPLETION",
  REPORT_COMPLETION: "REPORT_COMPLETION",
  UPVOTE: "UPVOTE",
  REPORT_VOTE_MILESTONE: "REPORT_VOTE_MILESTONE",
  REFERRAL: "REFERRAL",
  GIFT_REDEEM: "GIFT_REDEEM",
  GIFT_REDEEM_REFUND: "GIFT_REDEEM_REFUND",
  EXPIRE: "EXPIRE",
  MIGRATION_ADJUST: "MIGRATION_ADJUST",
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
  GREEN_POINT_LOT: "GREEN_POINT_LOT",
} as const;

export type GreenPointResourceTypeName =
  (typeof GreenPointResourceType)[keyof typeof GreenPointResourceType];

/** Ledger types that count towards "total earned" (old UPVOTE/REFERRAL rows included). */
export const EARNING_TRANSACTION_TYPES: string[] = [
  GreenPointTransactionType.CAMPAIGN_COMPLETION,
  GreenPointTransactionType.REPORT_VOTE_MILESTONE,
  GreenPointTransactionType.REPORT_COMPLETION,
  GreenPointTransactionType.UPVOTE,
  GreenPointTransactionType.REFERRAL,
];

/** Per-user ledger idempotency keys (spec 014 research R1). Never depend on the amount. */
export const IdempotencyKey = {
  campaignCompletion: (campaignId: string) => `campaign_completion:${campaignId}`,
  voteMilestone: (reportId: string, threshold: number) => `vote_milestone:${reportId}:${threshold}`,
  reportCompletion: (reportId: string) => `report_completion:${reportId}`,
  giftRedeem: (redemptionId: string) => `gift_redeem:${redemptionId}`,
  giftRedeemRefund: (redemptionId: string) => `gift_redeem_refund:${redemptionId}`,
  expire: (lotId: string) => `expire:${lotId}`,
  expireOnRefund: (lotId: string, redemptionId: string) => `expire:${lotId}:${redemptionId}`,
  migrationAdjust: (userId: string) => `migration_adjust:${userId}`,
};
