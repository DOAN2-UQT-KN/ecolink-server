import { PrismaClient } from "@prisma/client";
import prisma from "../../../config/prisma.client";

export class ReportManagerRepository {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = prisma;
  }

  async assignManager(data: {
    reportId: string;
    userId: string;
    assignedBy: string;
  }) {
    return this.prisma.reportManager.create({
      data: {
        reportId: data.reportId,
        userId: data.userId,
        assignedBy: data.assignedBy,
      },
    });
  }

  async findByReportIdAndUserId(reportId: string, userId: string) {
    return this.prisma.reportManager.findFirst({
      where: {
        reportId,
        userId,
        deletedAt: null,
      },
    });
  }

  async findManagersByReportId(reportId: string) {
    return this.prisma.reportManager.findMany({
      where: { reportId, deletedAt: null },
      orderBy: { assignedAt: "desc" },
    });
  }

  async findReportsByManagerId(userId: string) {
    return this.prisma.reportManager.findMany({
      where: { userId, deletedAt: null },
      include: {
        report: {
          select: {
            id: true,
            title: true,
            status: true,
            userId: true,
          },
        },
      },
      orderBy: { assignedAt: "desc" },
    });
  }

  async removeManager(reportId: string, userId: string) {
    return this.prisma.reportManager.update({
      where: {
        reportId_userId: { reportId, userId },
      },
      data: { deletedAt: new Date() },
    });
  }

  async isManager(reportId: string, userId: string): Promise<boolean> {
    const manager = await this.findByReportIdAndUserId(reportId, userId);
    return !!manager;
  }

  async assignMultipleManagers(data: {
    reportId: string;
    userIds: string[];
    assignedBy: string;
  }) {
    const assignments = data.userIds.map((userId) => ({
      reportId: data.reportId,
      userId,
      assignedBy: data.assignedBy,
    }));

    return this.prisma.reportManager.createMany({
      data: assignments,
      skipDuplicates: true, // Skip if already exists
    });
  }
}

// Singleton instance
export const reportManagerRepository = new ReportManagerRepository();
