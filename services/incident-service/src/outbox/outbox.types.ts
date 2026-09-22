/**
 * Outbox event types. The string values intentionally match the downstream
 * (reward-service) job-type strings so the relay can forward `eventType`
 * straight through to the reward enqueue endpoints.
 *
 * Not every value goes to reward any more — the relay routes by `eventType`, see
 * `RoutingOutboxPublisher`.
 */
export const OutboxEventType = {
  REPORT_COMPLETION_GREEN_POINTS: "REPORT_COMPLETION_GREEN_POINTS",
  CAMPAIGN_COMPLETION_GREEN_POINTS: "CAMPAIGN_COMPLETION_GREEN_POINTS",
  REPORT_VOTE_MILESTONE_GREEN_POINTS: "REPORT_VOTE_MILESTONE_GREEN_POINTS",
  CAMPAIGN_FACEBOOK_RECOGNITION: "CAMPAIGN_FACEBOOK_RECOGNITION",
  /**
   * Not a reward event: the second half of organization provisioning (create the ORG login
   * in identity-service, then attach it). It rides the outbox so it is written atomically
   * with the organization and retried with backoff instead of needing its own cron.
   */
  ORG_ACCOUNT_PROVISION: "ORG_ACCOUNT_PROVISION",
} as const;

export type OutboxEventType =
  (typeof OutboxEventType)[keyof typeof OutboxEventType];
