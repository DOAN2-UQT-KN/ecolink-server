import type { NotificationKind } from "@prisma/client";

/** @openapi */
export interface EnqueueNotificationJobRequest {
  /** Delivery channel: `email` or `website` (in-app). */
  type: "email" | "website";
  /** Template / semantic category (matches Handlebars templates under `templates/notifications/<kind>/`). */
  kind: NotificationKind;
  userId?: string;
  payload?: Record<string, string>;
}

/** @openapi */
export interface EnqueueNotificationJobResponseData {
  accepted: boolean;
}

/** @openapi */
export interface NotificationItemData {
  id: string;
  userId: string | null;
  type: string;
  kind: string;
  title: string;
  body: string;
  /**
   * Template variables plus optional `locales` for in-app notifications:
   * `{ en: { title, body }, vi: { title, body } }` (website channel).
   */
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

/** @openapi */
export interface NotificationListEnvelopeData {
  items: NotificationItemData[];
  unreadCount: number;
}
