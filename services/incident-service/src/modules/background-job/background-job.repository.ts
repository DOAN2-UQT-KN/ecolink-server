import prisma from "../../config/prisma.client";
import { GlobalStatus } from "../../constants/status.enum";

export class BackgroundJobRepository {
  async countJobsForPayload(
    jobType: string,
    payloadReportIdPath: string[],
    reportId: string,
  ): Promise<{ total: number; pendingOrInProcess: number }> {
    const baseWhere = {
      jobType,
      payload: {
        path: payloadReportIdPath,
        equals: reportId,
      },
    };

    const [total, pendingOrInProcess] = await Promise.all([
      prisma.backgroundJob.count({ where: baseWhere }),
      prisma.backgroundJob.count({
        where: {
          ...baseWhere,
          status: {
            in: [GlobalStatus._STATUS_PENDING, GlobalStatus._STATUS_INPROCESS],
          },
        },
      }),
    ]);

    return { total, pendingOrInProcess };
  }

  async cancelPendingJobs(
    jobType: string,
    payloadReportIdPath: string[],
    reportId: string,
  ): Promise<number> {
    const result = await prisma.backgroundJob.updateMany({
      where: {
        jobType,
        status: {
          in: [GlobalStatus._STATUS_PENDING, GlobalStatus._STATUS_INPROCESS],
        },
        payload: {
          path: payloadReportIdPath,
          equals: reportId,
        },
      },
      data: {
        status: GlobalStatus._STATUS_CANCELED,
        processedAt: new Date(),
      },
    });

    return result.count;
  }
}

export const backgroundJobRepository = new BackgroundJobRepository();