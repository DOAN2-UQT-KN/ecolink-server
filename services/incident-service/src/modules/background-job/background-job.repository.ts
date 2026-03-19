import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommandOutput,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import prisma from "../../config/prisma.client";
import {
  BackgroundJobEnvelope,
  BackgroundJobType,
  ReceivedBackgroundJob,
} from "./background-job.types";

export class BackgroundJobRepository {
  private readonly client: SQSClient;
  private readonly reportAnalysisQueueUrl: string;

  constructor() {
    const region = process.env.AWS_REGION || "us-east-1";
    const queueUrl = process.env.SQS_REPORT_ANALYSIS_QUEUE_URL;
    const endpoint =
      process.env.AWS_SQS_ENDPOINT || process.env.AWS_ENDPOINT_URL;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID || "test";
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || "test";

    if (!queueUrl) {
      throw new Error("SQS_REPORT_ANALYSIS_QUEUE_URL is not configured");
    }

    this.client = new SQSClient({
      region,
      endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
    this.reportAnalysisQueueUrl = queueUrl;
  }

  async enqueue(
    jobType: BackgroundJobType,
    payload: unknown,
    options?: { delaySeconds?: number },
  ): Promise<void> {
    const job = await prisma.backgroundJob.create({
      data: {
        jobType,
        payload: payload as object,
        status: "queued",
        attempts: 0,
      },
    });

    const envelope: BackgroundJobEnvelope = {
      jobId: job.id,
      version: 1,
      jobType,
      createdAt: new Date().toISOString(),
      payload,
    };

    try {
      const response = await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.reportAnalysisQueueUrl,
          MessageBody: JSON.stringify(envelope),
          DelaySeconds: options?.delaySeconds,
        }),
      );

      await this.markEnqueued(job.id, response);
    } catch (error) {
      await prisma.backgroundJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          processedAt: new Date(),
        },
      });
      throw error;
    }
  }

  async receive(
    maxNumberOfMessages: number,
    waitTimeSeconds: number,
    visibilityTimeoutSeconds: number,
  ): Promise<ReceivedBackgroundJob[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.reportAnalysisQueueUrl,
        MaxNumberOfMessages: maxNumberOfMessages,
        WaitTimeSeconds: waitTimeSeconds,
        VisibilityTimeout: visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );

    if (!response.Messages || response.Messages.length === 0) {
      return [];
    }

    return response.Messages.flatMap((message) => {
      if (!message.MessageId || !message.ReceiptHandle || !message.Body) {
        return [];
      }

      const count = Number(message.Attributes?.ApproximateReceiveCount ?? "1");

      return [
        {
          messageId: message.MessageId,
          receiptHandle: message.ReceiptHandle,
          body: message.Body,
          receiveCount: Number.isNaN(count) ? 1 : count,
        },
      ];
    });
  }

  async acknowledge(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.reportAnalysisQueueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async scheduleRetry(
    receiptHandle: string,
    delaySeconds: number,
  ): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.reportAnalysisQueueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: Math.max(0, Math.floor(delaySeconds)),
      }),
    );
  }

  async markProcessing(
    jobId: string,
    receiveCount: number,
  ): Promise<boolean> {
    const result = await prisma.backgroundJob.updateMany({
      where: {
        id: jobId,
        status: {
          in: ["queued", "processing"],
        },
      },
      data: {
        status: "processing",
        attempts: receiveCount,
      },
    });

    return result.count > 0;
  }

  async cancelPendingAnalyzeJobs(reportId: string): Promise<number> {
    const result = await prisma.backgroundJob.updateMany({
      where: {
        jobType: BackgroundJobType.ANALYZE_REPORT,
        status: {
          in: ["queued", "processing"],
        },
        payload: {
          path: ["reportId"],
          equals: reportId,
        },
      },
      data: {
        status: "cancelled",
        processedAt: new Date(),
      },
    });

    return result.count;
  }

  async markSucceeded(jobId: string): Promise<void> {
    await prisma.backgroundJob.update({
      where: { id: jobId },
      data: {
        status: "succeeded",
        processedAt: new Date(),
      },
    });
  }

  async markFailed(jobId: string): Promise<void> {
    await prisma.backgroundJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        processedAt: new Date(),
      },
    });
  }

  async markRetryScheduled(jobId: string): Promise<void> {
    await prisma.backgroundJob.update({
      where: { id: jobId },
      data: {
        status: "queued",
      },
    });
  }

  private async markEnqueued(
    jobId: string,
    _response: SendMessageCommandOutput,
  ): Promise<void> {
    await prisma.backgroundJob.update({
      where: { id: jobId },
      data: {
        status: "queued",
      },
    });
  }
}

export const backgroundJobRepository = new BackgroundJobRepository();
