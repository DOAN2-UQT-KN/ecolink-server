import { backgroundJobRepository } from "../../background-job/background-job.repository";
import {
  AnalyzeReportJobPayload,
  BackgroundJobEnvelope,
  BackgroundJobType,
  ReceivedBackgroundJob,
} from "../../background-job/background-job.types";
import { reportAiAnalysisService } from "../report-ai-analysis.service";

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

export class ReportAnalysisWorker {
  private readonly workerId = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  private isRunning = false;
  private isShuttingDown = false;

  start(): void {
    console.log(`[Worker ${this.workerId}] starting report analysis worker`);
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
    try {
      const parsed = this.parsePayload(message.body);

      const canProcess = await backgroundJobRepository.markProcessing(
        parsed.jobId,
        message.receiveCount,
      );

      if (!canProcess) {
        await backgroundJobRepository.acknowledge(message.receiptHandle);
        console.log(
          `[Worker ${this.workerId}] skipped canceled/stale message ${message.messageId} for job ${parsed.jobId}`,
        );
        return;
      }

      await reportAiAnalysisService.analyzeReport(
        parsed.payload.reportId,
        parsed.payload.mediaFiles,
      );
      await backgroundJobRepository.acknowledge(message.receiptHandle);
      await backgroundJobRepository.markSucceeded(parsed.jobId);
      console.log(
        `[Worker ${this.workerId}] completed message ${message.messageId} for report ${parsed.payload.reportId}`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      const parsed = this.tryParsePayload(message.body);

      if (message.receiveCount >= MAX_RECEIVE_COUNT) {
        await backgroundJobRepository.acknowledge(message.receiptHandle);
        if (parsed) {
          await backgroundJobRepository.markFailed(parsed.jobId);
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

      if (parsed) {
        await backgroundJobRepository.markRetryScheduled(parsed.jobId);
      }

      console.error(
        `[Worker ${this.workerId}] failed message ${message.messageId}: ${errorMessage} (receive ${message.receiveCount})`,
      );
    }
  }

  private parsePayload(rawBody: string): {
    jobId: string;
    payload: AnalyzeReportJobPayload;
  } {
    let envelope: unknown;

    try {
      envelope = JSON.parse(rawBody);
    } catch {
      throw new Error("Invalid JSON message body");
    }

    const parsedEnvelope = envelope as Partial<
      BackgroundJobEnvelope<AnalyzeReportJobPayload>
    >;

    if (typeof parsedEnvelope.jobId !== "string" || !parsedEnvelope.jobId) {
      throw new Error("Missing jobId in message envelope");
    }

    if (parsedEnvelope.jobType !== BackgroundJobType.ANALYZE_REPORT) {
      throw new Error(
        `Unsupported job type: ${String(parsedEnvelope.jobType)}`,
      );
    }

    const payload = parsedEnvelope.payload as Partial<AnalyzeReportJobPayload>;

    if (
      !payload ||
      typeof payload.reportId !== "string" ||
      !Array.isArray(payload.mediaFiles)
    ) {
      throw new Error("Invalid report analysis payload");
    }

    const mediaFiles = payload.mediaFiles.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );

    if (mediaFiles.length === 0) {
      throw new Error("Report analysis payload has no media files");
    }

    return {
      jobId: parsedEnvelope.jobId,
      payload: {
        reportId: payload.reportId,
        mediaFiles,
      },
    };
  }

  private tryParsePayload(rawBody: string): {
    jobId: string;
    payload: AnalyzeReportJobPayload;
  } | null {
    try {
      return this.parsePayload(rawBody);
    } catch {
      return null;
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
