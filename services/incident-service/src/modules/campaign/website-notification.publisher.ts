import type { OutboxEventMessage, OutboxPublisher } from "../../outbox/outbox-publisher";
import { enqueueWebsiteNotificationsToUsers } from "./notification-jobs.client";

/** Payload of a `WEBSITE_NOTIFICATION` outbox event. */
export interface WebsiteNotificationPayload {
  kind: string;
  userIds: string[];
  payload: Record<string, string>;
}

function parsePayload(raw: unknown): WebsiteNotificationPayload {
  const value = (raw ?? {}) as Partial<WebsiteNotificationPayload>;
  if (!value.kind || !Array.isArray(value.userIds)) {
    throw new Error("WEBSITE_NOTIFICATION payload is incomplete");
  }
  return { kind: value.kind, userIds: value.userIds, payload: value.payload ?? {} };
}

/**
 * Sends an in-app notification written by a business transaction, so it is not lost when
 * notification-service is down or rejects the kind. Throwing makes the relay retry with backoff;
 * a retry may repeat the notification for users the failed attempt already reached.
 */
export class WebsiteNotificationPublisher implements OutboxPublisher {
  async publish(event: OutboxEventMessage): Promise<void> {
    const { kind, userIds, payload } = parsePayload(event.payload);
    if (userIds.length === 0) return;
    await enqueueWebsiteNotificationsToUsers({ kind, userIds, payload });
  }
}

export const websiteNotificationPublisher = new WebsiteNotificationPublisher();
