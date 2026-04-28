import { SqsBackgroundJobQueue } from "@da2/queue";
import type { QueueThresholdConfig } from "@da2/queue";
import type { BackgroundJobStore } from "@da2/queue";

function getSqsConfig(): object {
  return {
    region: process.env.AWS_REGION || "us-east-1",
    endpoint: process.env.AWS_SQS_ENDPOINT || process.env.AWS_ENDPOINT_URL,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
  };
}

/**
 * Service-specific factory for creating SqsBackgroundJobQueue instances.
 * Only holds SQS config — store is passed per-route from the shared BackgroundJobStore.
 */
export class ReportSqsQueueFactory {
  constructor(private readonly thresholds: QueueThresholdConfig = {}) {}

  createQueue(
    queueUrlEnvVar: string,
    store: BackgroundJobStore,
    thresholds?: QueueThresholdConfig,
  ) {
    const queueUrl = process.env[queueUrlEnvVar];
    console.log("QUEUE URL", queueUrl, "!!@")
    if (!queueUrl) {
      throw new Error(`${queueUrlEnvVar} is not configured`);
    }

    return new SqsBackgroundJobQueue({
      sqsClientConfig: getSqsConfig(),
      queueUrl,
      store,
      thresholds: { ...this.thresholds, ...thresholds },
    });
  }
}