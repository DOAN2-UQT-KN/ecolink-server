import type { Prisma } from "@prisma/client";
import prisma from "../../config/prisma.client";

export type VerificationWithChecks = Prisma.ReportVerificationGetPayload<{ include: { checks: true } }>;

/**
 * Reads verification attempts. Ordered by attempt (not latestVerificationId) so an attempt
 * still RUNNING, not yet linked from the report, is returned too.
 */
export const verificationQueryService = {
  findLatest(reportId: string): Promise<VerificationWithChecks | null> {
    return prisma.reportVerification.findFirst({
      where: { reportId },
      orderBy: { attempt: "desc" },
      include: { checks: true },
    });
  },

  findAll(reportId: string): Promise<VerificationWithChecks[]> {
    return prisma.reportVerification.findMany({
      where: { reportId },
      orderBy: { attempt: "desc" },
      include: { checks: true },
    });
  },
};
