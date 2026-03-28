import { backgroundJobRepository } from "../background-job.repository";
import { parseBackgroundJobEnvelopeLoose } from "../background-job-envelope.util";
import { ReceivedBackgroundJob } from "../background-job.types";
import type { BackgroundJobMessageHandler } from "./background-job-handler.types";

const WAIT_TIME_SECONDS = Number(
  process.env.WORKER_SQS_WAIT_TIME_SECONDS || 20,
);
const VISIBILITY_TIMEOUT_SECONDS = Number(
  process.env.WORKER_SQS_VISIBILITY_TIMEOUT_SECONDS || 120,
);
const BATCH_SIZE = Number(process.env.WORKER_BATCH_SIZE || 5);
const MAX_RECEIVE_COUNT = Number(process.env.WORKER_MAX_RECEIVE_COUNT || 5);
const RETRY_BASE_SECONDS = Number(process.env.WORKER_RETRY_BASE_SECONDS || 30);
const MAX_RETRY_DELAY_SECONDS = Number(
  process.env.WORKER_MAX_RETRY_DELAY_SECONDS || 900,
);
const ERROR_BACKOFF_MS = 2_000;

export class BackgroundJobOrchestratorWorker {
  private readonly workerId = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  private readonly handlersByT
  ype: Map<string, BackgroundJobMessageHandler>;
  private isRunning = false;
  private isShuttingDown = false;

  constructor(handlers: BackgroundJobMessageHandler[]) {
    this.handlersByType = new Map(
      handlers.map((h) => [h.jobType as string, h]),
    );
  }

  start(): void {
    console.log(
      `[Worker ${this.workerId}] starting background job orchestrator (${this.handlersByType.size} handler(s))`,
    );
    void this.pollLoop();
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;

    while (this.isRunning) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    console.log(`[Worker ${this.workerId}] stopped`);
  }

  private async pollLoop(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    try {
      while (!this.isShuttingDown) {
        const messages = await backgroundJobRepository.receive(
          BATCH_SIZE,
          WAIT_TIME_SECONDS,
          VISIBILITY_TIMEOUT_SECONDS,
        );

        for (const message of messages) {
          if (this.isShuttingDown) {
            break;
          }

          await this.processMessage(message);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Worker ${this.workerId}] polling failed: ${message}`);
      await this.sleep(ERROR_BACKOFF_MS);
    } finally {
      this.isRunning = false;

      if (!this.isShuttingDown) {
        void this.pollLoop();
      }
    }
  }

  private async processMessage(message: ReceivedBackgroundJob): Promise<void> {
    const loose = parseBackgroundJobEnvelopeLoose(message.body);

    try {
      if (!loose) {
        throw new Error("Invalid JSON or missing jobId/jobType in envelope");
      }

      const handler = this.handlersByType.get(loose.jobType);
      if (!handler) {
        console.error(
          `[Worker ${this.workerId}] no handler for job type ${loose.jobType}, acknowledging message ${message.messageId}`,
        );
        try {
          await backgroundJobRepository.markFailed(loose.jobId);
        } catch {
          console.warn(
            `[Worker ${this.workerId}] could not mark job ${loose.jobId} failed (missing row?)`,
          );
        }
        await backgroundJobRepository.acknowledge(message.receiptHandle);
        return;
      }

      const { jobId, run } = handler.parseAndPrepare(message.body);

      const canProcess = await backgroundJobRepository.markProcessing(
        jobId,
        message.receiveCount,
      );

      if (!canProcess) {
        await backgroundJobRepository.acknowledge(message.receiptHandle);
        console.log(
          `[Worker ${this.workerId}] skipped canceled/stale message ${message.messageId} for job ${jobId}`,
        );
        return;
      }

      await run();
      await backgroundJobRepository.acknowledge(message.receiptHandle);
      await backgroundJobRepository.markSucceeded(jobId);
      console.log(
        `[Worker ${this.workerId}] completed message ${message.messageId} for job ${jobId}`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      const jobIdForStatus = loose?.jobId ?? null;

      if (message.receiveCount >= MAX_RECEIVE_COUNT) {
        await backgroundJobRepository.acknowledge(message.receiptHandle);
        if (jobIdForStatus) {
          await backgroundJobRepository.markFailed(jobIdForStatus);
        }
        console.error(
          `[Worker ${this.workerId}] dropped message ${message.messageId} after ${message.receiveCount} receives: ${errorMessage}`,
        );
        return;
      }

      const retryDelaySeconds = Math.min(
        MAX_RETRY_DELAY_SECONDS,
        RETRY_BASE_SECONDS * 2 ** Math.max(0, message.receiveCount - 1),
      );

      await backgroundJobRepository.scheduleRetry(
        message.receiptHandle,
        retryDelaySeconds,
      );

      if (jobIdForStatus) {
        await backgroundJobRepository.markRetryScheduled(jobIdForStatus);
      }

      console.error(
        `[Worker ${this.workerId}] failed message ${message.messageId}: ${errorMessage} (receive ${message.receiveCount})`,
      );
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
