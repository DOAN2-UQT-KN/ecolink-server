import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { Prisma } from "@prisma/client";

/** One outbox row's worth of data the publisher needs to deliver it. */
export interface OutboxEventMessage {
  id: string;
  eventType: string;
  payload: Prisma.JsonValue;
}

/**
 * Transport the relay uses to hand an outbox event to reward-service. The
 * default ships events to a shared SQS queue; tests inject a fake.
 */
export interface OutboxPublisher {
  publish(event: OutboxEventMessage): Promise<void>;
}

/**
 * Publishes outbox events onto the reward intake SQS queue. The envelope shape
 * matches `@da2/queue` (jobId/version/jobType/payload) so the reward intake
 * worker can consume it directly. Delivery is at-least-once; the reward ledger
 * is idempotent.
 */
export class SqsOutboxPublisher implements OutboxPublisher {
  private readonly sqs: SQSClient;
  private readonly queueUrl: string;

  constructor() {
    const queueUrl = process.env.SQS_REWARD_INTAKE_QUEUE_URL?.trim();
    if (!queueUrl) {
      throw new Error(
        "SQS_REWARD_INTAKE_QUEUE_URL must be configured for the outbox relay",
      );
    }
    this.queueUrl = queueUrl;
    this.sqs = new SQSClient({
      region: process.env.AWS_REGION || "us-east-1",
      endpoint: process.env.AWS_SQS_ENDPOINT || process.env.AWS_ENDPOINT_URL,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      },
    });
  }

  async publish(event: OutboxEventMessage): Promise<void> {
    const envelope = {
      jobId: event.id,
      version: 1,
      jobType: event.eventType,
      createdAt: new Date().toISOString(),
      payload: event.payload,
    };
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(envelope),
      }),
    );
  }
}

/**
 * Sends each event to the transport its `eventType` belongs to.
 *
 * Reward events keep going to the shared SQS intake. Organization provisioning is a
 * synchronous call into identity-service instead, but it still rides the outbox so it is
 * written in the same transaction as the organization row and inherits the relay's retry
 * with backoff — no separate cron, no dual write.
 */
export class RoutingOutboxPublisher implements OutboxPublisher {
  constructor(
    private readonly routes: Record<string, OutboxPublisher>,
    private readonly fallback: () => OutboxPublisher,
  ) {}

  async publish(event: OutboxEventMessage): Promise<void> {
    const publisher = this.routes[event.eventType] ?? this.fallback();
    await publisher.publish(event);
  }
}
