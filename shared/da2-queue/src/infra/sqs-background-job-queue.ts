import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type {
  BackgroundJobQueue,
  EnqueueOptions,
  ReceivedMessage,
} from "../core/background-job-queue.interface";
import type { BackgroundJobStore } from "../core/background-job-store";
import type { QueueThresholdConfig } from "../core/queue-worker";

export interface SqsBackgroundJobQueueOptions {
  /**
   * Plain config object passed to `new SQSClient(options)`.
   * Using `object` avoids cross-package AWS SDK version type conflicts.
   */
  sqsClientConfig: object;
  queueUrl: string;
  store: BackgroundJobStore;
  thresholds?: QueueThresholdConfig;
}

/**
 * SQS-backed durable queue. Handles enqueue (DB row + SQS send) and SQS primitives.
 * Does NOT own polling or message processing — those live in {@link QueueWorker}.
 *
 * The SQSClient is created internally from `sqsClientConfig`, so this class is
 * source-compatible with any service regardless of which @aws-sdk version they use.
 */
export class SqsBackgroundJobQueue implements BackgroundJobQueue {
  private readonly _sqs: SQSClient;

  constructor(private readonly options: SqsBackgroundJobQueueOptions) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this._sqs = new SQSClient(options.sqsClientConfig as any);
  }

  get queueUrl(): string {
    return this.options.queueUrl;
  }

  async enqueue(
    jobType: string,
    payload: unknown,
    options?: EnqueueOptions,
  ): Promise<void> {
    const jobId = await this.options.store.createJob(jobType, payload);

    const envelope = {
      jobId,
      version: 1,
      jobType,
      createdAt: new Date().toISOString(),
      payload,
    };

    try {
      await this._sqs.send(
        new SendMessageCommand({
          QueueUrl: this.options.queueUrl,
          MessageBody: JSON.stringify(envelope),
          DelaySeconds: options?.delaySeconds,
        }),
      );
      await this.options.store.markEnqueued(jobId);
    } catch (err) {
      await this.options.store.markFailedWithoutSend(jobId);
      throw err;
    }
  }

  async peekBatch(maxNumberOfMessages?: number): Promise<ReceivedMessage[]> {
    const response = await this._sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.options.queueUrl,
        MaxNumberOfMessages:
          maxNumberOfMessages ??
          this.options.thresholds?.batchSize ??
          5,
        WaitTimeSeconds: this.options.thresholds?.waitTimeSeconds ?? 20,
        VisibilityTimeout:
          this.options.thresholds?.visibilityTimeoutSeconds ?? 120,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );

    if (!response.Messages || response.Messages.length === 0) {
      return [];
    }

    return response.Messages.flatMap(
      (msg: {
        MessageId?: string;
        ReceiptHandle?: string;
        Body?: string;
        Attributes?: Record<string, string>;
      }) => {
        if (!msg.MessageId || !msg.ReceiptHandle || !msg.Body) return [];
        const count = Number(msg.Attributes?.ApproximateReceiveCount ?? "1");
        return [
          {
            queueUrl: this.options.queueUrl,
            messageId: msg.MessageId,
            receiptHandle: msg.ReceiptHandle,
            body: msg.Body,
            receiveCount: Number.isNaN(count) ? 1 : count,
          },
        ];
      },
    );
  }

  async changeVisibility(
    receiptHandle: string,
    visibilityTimeoutSeconds: number,
  ): Promise<void> {
    await this._sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: Math.max(0, Math.floor(visibilityTimeoutSeconds)),
      }),
    );
  }

  async acknowledge(receiptHandle: string): Promise<void> {
    await this._sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }
}