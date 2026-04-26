import { QueueWorker } from "@da2/queue";
import type {
  BackgroundJobEnvelope,
  BackgroundJobQueue,
  QueueThresholdConfig,
} from "@da2/queue";
import { notificationProcessor } from "../../modules/notification/notification.processor";
import {
  NotificationJobType,
  type SendNotificationJobPayload,
} from "../notification-job.types";

export class NotificationSendWorker extends QueueWorker {
  protected readonly jobType = NotificationJobType.SEND_NOTIFICATION;

  constructor(
    queue: BackgroundJobQueue,
    store: ConstructorParameters<typeof QueueWorker>[1],
    threshold: QueueThresholdConfig,
  ) {
    super(queue, store, threshold);
  }

  protected async process(body: string, _jobId: string): Promise<void> {
    const envelope = JSON.parse(
      body,
    ) as BackgroundJobEnvelope<SendNotificationJobPayload>;
    const payload = envelope.payload;

    if (
      !payload ||
      (payload.type !== "email" && payload.type !== "website") ||
      typeof payload.kind !== "string"
    ) {
      throw new Error("Invalid notification payload");
    }

    await notificationProcessor.process(payload);
  }
}
