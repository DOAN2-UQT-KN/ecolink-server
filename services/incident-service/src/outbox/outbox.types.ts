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
   * Not a reward event: after an application is approved, one per owner, to send either the
   * account-activation link or the "you were added as owner" email. It rides the outbox so
   * it is written atomically with the memberships and retried with backoff.
   */
  ORG_OWNER_ONBOARD: "ORG_OWNER_ONBOARD",
} as const;

export type OutboxEventType =
  (typeof OutboxEventType)[keyof typeof OutboxEventType];
