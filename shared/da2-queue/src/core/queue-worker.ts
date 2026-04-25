import "dotenv/config";
import { parseBackgroundJobEnvelopeLoose } from "./background-job-envelope.util";
import type {
  BackgroundJobQueue,
  ReceivedMessage,
} from "./background-job-queue.interface";

const DEFAULT_THRESHOLD = {
  maxRetries: 5,
  retryBaseSeconds: 30,
  maxRetryDelaySeconds: 900,
  visibilityTimeoutSeconds: 120,
  batchSize: 5,
  waitTimeSeconds: 20,
};

const ERROR_BACKOFF_MS = 2_000;

export interface QueueThresholdConfig {
  maxRetries?: number;
  retryBaseSeconds?: number;
  maxRetryDelaySeconds?: number;
  visibilityTimeoutSeconds?: number;
  batchSize?: number;
  waitTimeSeconds?: number;
}

/**
 * Abstract base for a job-type-specific worker.
 * Subclasses implement {@link process} to define what happens for each message.
 *
 * The base handles: polling loop, retry/backoff, markProcessing/Succeeded/Failed,
 * message acknowledgement, and routing by jobType.
 *
 * Each concrete worker is injected with its {@link BackgroundJobQueue}.
 */
export abstract class QueueWorker {
  private isRunning = false;
  private isShuttingDown = false;

  constructor(
    protected readonly queue: BackgroundJobQueue,
    protected readonly store: {
      markProcessing(jobId: string, receiveCount: number): Promise<boolean>;
      markSucceeded(jobId: string): Promise<void>;
      markFailed(jobId: string): Promise<void>;
      markRetryScheduled(jobId: string): Promise<void>;
    },
    protected readonly threshold: QueueThresholdConfig,
  ) {}

  /** The jobType this worker handles. */
  protected abstract readonly jobType: string;

  /**
   * Process a validated message body for this worker's jobType.
   * Called after markProcessing succeeds; throw on failure to trigger retry.
   */
  protected abstract process(body: string, jobId: string): Promise<void>;

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[${this.constructor.name} ${this.queue.queueUrl}] started`);
    void this.pollLoop();
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;
    while (this.isRunning) {
      await sleep(100);
    }
    console.log(`[${this.constructor.name} ${this.queue.queueUrl}] stopped`);
  }

  // ─── Polling loop ────────────────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    if (this.isShuttingDown) {
      this.isRunning = false;
      return;
    }
    this.isRunning = true;

    try {
      while (!this.isShuttingDown) {
        const messages = await this.queue.peekBatch(
          this.threshold.batchSize ?? DEFAULT_THRESHOLD.batchSize,
        );

        for (const msg of messages) {
          if (this.isShuttingDown) break;
          await this.processMessage(msg);
        }
      }
    } catch (err) {
      console.error(
        `[${this.constructor.name} ${this.queue.queueUrl}] poll error: ${(err as Error).message}`,
      );
      await sleep(ERROR_BACKOFF_MS);
    } finally {
      this.isRunning = false;
      if (!this.isShuttingDown) void this.pollLoop();
    }
  }

  // ─── Message dispatch ────────────────────────────────────────────────────────

  private async processMessage(msg: ReceivedMessage): Promise<void> {
    const loose = parseBackgroundJobEnvelopeLoose(msg.body);

    try {
      if (!loose) throw new Error("Invalid JSON or missing jobId/jobType");

      if (loose.jobType !== this.jobType) {
        console.error(
          `[${this.constructor.name} ${this.queue.queueUrl}] unexpected jobType ${loose.jobType} on ${msg.messageId}, expected ${this.jobType}`,
        );
        try { await this.store.markFailed(loose.jobId); } catch { /* no-op */ }
        await this.queue.acknowledge(msg.receiptHandle);
        return;
      }

      const canProcess = await this.store.markProcessing(loose.jobId, msg.receiveCount);
      if (!canProcess) {
        await this.queue.acknowledge(msg.receiptHandle);
        console.log(
          `[${this.constructor.name} ${this.queue.queueUrl}] skipped stale ${msg.messageId}`,
        );
        return;
      }

      await this.process(msg.body, loose.jobId);
      await this.queue.acknowledge(msg.receiptHandle);
      await this.store.markSucceeded(loose.jobId);
      console.log(`[${this.constructor.name} ${this.queue.queueUrl}] done ${msg.messageId}`);
    } catch (err) {
      const errorMsg = (err as Error).message;
      const maxRetries = this.threshold.maxRetries ?? DEFAULT_THRESHOLD.maxRetries;

      if (msg.receiveCount >= maxRetries) {
        await this.queue.acknowledge(msg.receiptHandle);
        if (loose?.jobId) await this.store.markFailed(loose.jobId);
        console.error(
          `[${this.constructor.name} ${this.queue.queueUrl}] dropped ${msg.messageId} after ${msg.receiveCount} attempts: ${errorMsg}`,
        );
        return;
      }

      const baseSeconds = this.threshold.retryBaseSeconds ?? DEFAULT_THRESHOLD.retryBaseSeconds;
      const maxDelay = this.threshold.maxRetryDelaySeconds ?? DEFAULT_THRESHOLD.maxRetryDelaySeconds;
      const retryDelay = Math.min(
        maxDelay,
        baseSeconds * 2 ** Math.max(0, msg.receiveCount - 1),
      );

      await this.queue.changeVisibility(msg.receiptHandle, retryDelay);
      if (loose?.jobId) await this.store.markRetryScheduled(loose.jobId);
      console.error(
        `[${this.constructor.name} ${this.queue.queueUrl}] failed ${msg.messageId} (receive ${msg.receiveCount}): ${errorMsg}`,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
