import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { Prisma } from "@prisma/client";
import { OutboxEventType } from "./outbox.types";

/** One outbox row's worth of data the publisher needs to deliver it. */
export interface OutboxEventMessage {
  id: string;
  eventType: string;
  payload: Prisma.JsonValue;
}

/**
 * Transport the relay uses to hand an outbox event to a downstream SQS queue.
 * Tests inject a fake.
 */
export interface OutboxPublisher {
  publish(event: OutboxEventMessage): Promise<void>;
}

function requireQueueUrl(envName: string): string {
  const queueUrl = process.env[envName]?.trim();
  if (!queueUrl) {
    throw new Error(`${envName} must be configured for the outbox relay`);
  }
  return queueUrl;
}

/**
 * Resolves the SQS destination for an outbox event.
 * `REPORT_SUBMITTED` → report-verification queue when `REPORT_VERIFICATION_ENABLED=true`
 * (specs/006 P05), otherwise the legacy AI duplicate-check queue; all other known types → reward intake.
 */
export function resolveOutboxQueueUrl(eventType: string): string {
  if (eventType === OutboxEventType.REPORT_SUBMITTED) {
    return requireQueueUrl(
      process.env.REPORT_VERIFICATION_ENABLED === "true"
        ? "SQS_REPORT_VERIFICATION_QUEUE_URL"
        : "SQS_AI_ANALYSIS_QUEUE_URL",
    );
  }
  return requireQueueUrl("SQS_REWARD_INTAKE_QUEUE_URL");
}

/**
 * Publishes outbox events onto the appropriate SQS queue. The envelope shape
 * matches `@da2/queue` (jobId/version/jobType/payload) so downstream workers
 * can consume it directly. Delivery is at-least-once.
 */
export class SqsOutboxPublisher implements OutboxPublisher {
  private readonly sqs: SQSClient;

  constructor() {
    // Validate reward URL eagerly so misconfig fails at relay start for the
    // common path; AI URL is validated on first REPORT_SUBMITTED publish.
    requireQueueUrl("SQS_REWARD_INTAKE_QUEUE_URL");
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
    const queueUrl = resolveOutboxQueueUrl(event.eventType);
    const envelope = {
      jobId: event.id,
      version: 1,
      jobType: event.eventType,
      createdAt: new Date().toISOString(),
      payload: event.payload,
    };
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(envelope),
      }),
    );
  }
}

/**
 * Sends each event to the transport its `eventType` belongs to.
 *
 * Reward events keep going to the shared SQS intake. Owner onboarding after an approval
 * (activation link or "you were added" email) is handled in-process instead, but it still
 * rides the outbox so it is written in the same transaction as the memberships and inherits
 * the relay's retry with backoff — no separate cron, no dual write.
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
