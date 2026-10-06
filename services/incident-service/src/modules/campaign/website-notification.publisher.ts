import type { OutboxEventMessage, OutboxPublisher } from "../../outbox/outbox-publisher";
import { enqueueEmailToUser } from "../organization_application/organization-application-notify.client";
import { enqueueWebsiteNotificationsToUsers } from "./notification-jobs.client";

/** Payload of a `WEBSITE_NOTIFICATION` outbox event. */
export interface WebsiteNotificationPayload {
  kind: string;
  userIds: string[];
  payload: Record<string, string>;
  /** Also mail each user (same kind; notification-service resolves the address). */
  email?: boolean;
}

function parsePayload(raw: unknown): WebsiteNotificationPayload {
  const value = (raw ?? {}) as Partial<WebsiteNotificationPayload>;
  if (!value.kind || !Array.isArray(value.userIds)) {
    throw new Error("WEBSITE_NOTIFICATION payload is incomplete");
  }
  return {
    kind: value.kind,
    userIds: value.userIds,
    payload: value.payload ?? {},
    email: value.email === true,
  };
}

/**
 * Sends an in-app notification written by a business transaction, so it is not lost when
 * notification-service is down or rejects the kind. Throwing makes the relay retry with backoff;
 * a retry may repeat the notification for users the failed attempt already reached.
 */
export class WebsiteNotificationPublisher implements OutboxPublisher {
  async publish(event: OutboxEventMessage): Promise<void> {
    const { kind, userIds, payload, email } = parsePayload(event.payload);
    if (userIds.length === 0) return;
    await enqueueWebsiteNotificationsToUsers({ kind, userIds, payload });
    if (email) {
      await Promise.all(userIds.map((userId) => enqueueEmailToUser(kind, userId, payload)));
    }
  }
}

export const websiteNotificationPublisher = new WebsiteNotificationPublisher();
