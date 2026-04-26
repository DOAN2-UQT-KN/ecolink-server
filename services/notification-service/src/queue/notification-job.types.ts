import type { NotificationKind } from "@prisma/client";

export enum NotificationJobType {
  SEND_NOTIFICATION = "SEND_NOTIFICATION",
}

export interface SendNotificationJobPayload {
  type: "email" | "website";
  kind: NotificationKind;
  userId?: string;
  payload?: Record<string, string>;
}
