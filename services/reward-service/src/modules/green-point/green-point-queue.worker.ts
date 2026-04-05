import { getGreenPointSqsRepository } from "./green-point-sqs.repository";
import { greenPointFactory, greenPointService } from "./green-point.instances";

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

function parseEnvelope(
  body: string,
): { version: number; jobType: string; payload: unknown } | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const o = parsed as Record<string, unknown>;
    if (o.version !== 1 || typeof o.jobType !== "string" || !o.jobType) {
      return null;
    }
    if (!("payload" in o)) {
      return null;
    }
    return {
      version: 1,
      jobType: o.jobType,
      payload: o.payload,
    };
  } catch {
    return null;
  }
}

export class GreenPointQueueWorker {
  private readonly workerId = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  private readonly sqs = getGreenPointSqsRepository();
  private isRunning = false;
  private isShuttingDown = false;

  start(): void {
    console.log(
      `[GreenPointWorker ${this.workerId}] starting (Serializable balance updates)`,
    );
    void this.pollLoop();
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;
    while (this.isRunning) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    console.log(`[GreenPointWorker ${this.workerId}] stopped`);
  }

  private async pollLoop(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;

    try {
      while (!this.isShuttingDown) {
        const messages = await this.sqs.receiveMessages(
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
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[GreenPointWorker ${this.workerId}] poll error: ${msg}`);
      await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
    } finally {
      this.isRunning = false;
      if (!this.isShuttingDown) {
        void this.pollLoop();
      }
    }
  }

  private async processMessage(message: {
    messageId: string;
    receiptHandle: string;
    body: string;
    receiveCount: number;
  }): Promise<void> {
    const envelope = parseEnvelope(message.body);

    try {
      if (!envelope) {
        console.error(
          `[GreenPointWorker ${this.workerId}] invalid envelope, ack ${message.messageId}`,
        );
        await this.sqs.acknowledge(message.receiptHandle);
        return;
      }

      if (!greenPointFactory.supportsJobType(envelope.jobType)) {
        console.error(
          `[GreenPointWorker ${this.workerId}] unknown jobType ${envelope.jobType}, ack ${message.messageId}`,
        );
        await this.sqs.acknowledge(message.receiptHandle);
        return;
      }

      const result = await greenPointService.applyQueuedJob({
        jobType: envelope.jobType,
        payload: envelope.payload,
      });
      await this.sqs.acknowledge(message.receiptHandle);
      console.log(
        `[GreenPointWorker ${this.workerId}] jobType=${envelope.jobType} credited=${result.credited} skipped=${result.skipped} (msg ${message.messageId})`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (message.receiveCount >= MAX_RECEIVE_COUNT) {
        await this.sqs.acknowledge(message.receiptHandle);
        console.error(
          `[GreenPointWorker ${this.workerId}] dropped ${message.messageId} after ${message.receiveCount} receives: ${errorMessage}`,
        );
        return;
      }

      const retryDelaySeconds = Math.min(
        MAX_RETRY_DELAY_SECONDS,
        RETRY_BASE_SECONDS * 2 ** Math.max(0, message.receiveCount - 1),
      );
      await this.sqs.scheduleRetry(message.receiptHandle, retryDelaySeconds);
      console.error(
        `[GreenPointWorker ${this.workerId}] retry ${message.messageId}: ${errorMessage} (receive ${message.receiveCount})`,
      );
    }
  }
}
