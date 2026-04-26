import type { BackgroundJobStore } from "@da2/queue";
import { GlobalStatus } from "@da2/constants";
import { prisma } from "../lib/prisma";

export class NotificationBackgroundJobStore implements BackgroundJobStore {
  async createJob(jobType: string, payload: unknown): Promise<string> {
    const job = await prisma.notificationJob.create({
      data: {
        jobType,
        payload: payload as object,
        status: GlobalStatus._STATUS_PENDING,
        attempts: 0,
      },
    });
    return job.id;
  }

  async markProcessing(jobId: string, receiveCount: number): Promise<boolean> {
    const result = await prisma.notificationJob.updateMany({
      where: {
        id: jobId,
        status: {
          in: [GlobalStatus._STATUS_PENDING, GlobalStatus._STATUS_INPROCESS],
        },
      },
      data: {
        status: GlobalStatus._STATUS_INPROCESS,
        attempts: receiveCount,
      },
    });
    return result.count > 0;
  }

  async markSucceeded(jobId: string): Promise<void> {
    await prisma.notificationJob.update({
      where: { id: jobId },
      data: {
        status: GlobalStatus._STATUS_COMPLETED,
        processedAt: new Date(),
      },
    });
  }

  async markFailed(jobId: string): Promise<void> {
    await prisma.notificationJob.update({
      where: { id: jobId },
      data: {
        status: GlobalStatus._STATUS_FAILED,
        processedAt: new Date(),
      },
    });
  }

  async markRetryScheduled(jobId: string): Promise<void> {
    await prisma.notificationJob.update({
      where: { id: jobId },
      data: { status: GlobalStatus._STATUS_PENDING },
    });
  }

  async markEnqueued(jobId: string): Promise<void> {
    await prisma.notificationJob.update({
      where: { id: jobId },
      data: { status: GlobalStatus._STATUS_PENDING },
    });
  }

  async markFailedWithoutSend(jobId: string): Promise<void> {
    await prisma.notificationJob.update({
      where: { id: jobId },
      data: {
        status: GlobalStatus._STATUS_FAILED,
        processedAt: new Date(),
      },
    });
  }
}
