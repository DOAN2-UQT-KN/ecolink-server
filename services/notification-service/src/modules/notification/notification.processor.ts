import type { Notification } from "@prisma/client";
import { getChannel } from "../../channels/channel.factory";
import {
  isValidNotificationKind,
  normalizePayload,
} from "../../channels/notification-channel.strategy";
import type { SendNotificationJobPayload } from "../../queue/notification-job.types";

/**
 * Queue worker entry: validate job, resolve channel strategy, deliver.
 */
export class NotificationProcessor {
  async process(
    input: SendNotificationJobPayload,
  ): Promise<{
    notification: Notification;
    emailSent?: boolean;
    emailSkippedReason?: string;
  }> {
    if (!isValidNotificationKind(input.kind)) {
      throw new Error("Invalid notification kind");
    }

    const channel = getChannel(input.type);
    const payload = normalizePayload(input.payload);

    return channel.deliver(input, payload);
  }
}

export const notificationProcessor = new NotificationProcessor();
