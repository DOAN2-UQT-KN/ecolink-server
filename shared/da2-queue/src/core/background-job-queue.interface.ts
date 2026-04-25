export interface EnqueueOptions {
  delaySeconds?: number;
}

export interface ReceivedMessage {
  queueUrl: string;
  messageId: string;
  receiptHandle: string;
  body: string;
  receiveCount: number;
}

/**
 * Producer contract for a durable background-job queue.
 * Implementations handle enqueueing (DB row + SQS send) but NOT polling or message processing.
 */
export interface BackgroundJobQueue {
  readonly queueUrl: string;

  enqueue(
    jobType: string,
    payload: unknown,
    options?: EnqueueOptions,
  ): Promise<void>;

  peekBatch(maxNumberOfMessages?: number): Promise<ReceivedMessage[]>;
  changeVisibility(receiptHandle: string, visibilityTimeoutSeconds: number): Promise<void>;
  acknowledge(receiptHandle: string): Promise<void>;
}
