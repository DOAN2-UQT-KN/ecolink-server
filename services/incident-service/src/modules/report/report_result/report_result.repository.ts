import { PrismaClient } from "@prisma/client";
import prisma from "../../../config/prisma.client";
import { ResultStatus } from "../../../constants/status.enum";

export class ReportResultRepository {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = prisma;
  }

  async create(data: {
    id?: string;
    reportId: string;
    submittedByManagerId: string;
    description?: string;
  }) {
    return this.prisma.reportResult.create({
      data: {
        reportId: data.reportId,
        submittedByManagerId: data.submittedByManagerId,
        description: data.description,
        status: ResultStatus.PENDING_APPROVAL,
      },
    });
  }

  async findById(id: string) {
    return this.prisma.reportResult.findUnique({
      where: { id },
    });
  }

  async findByIdWithRelations(id: string) {
    return this.prisma.reportResult.findUnique({
      where: { id },
      include: {
        reportMediaFiles: true,
        report: {
          select: {
            id: true,
            title: true,
            status: true,
            userId: true,
          },
        },
      },
    });
  }

  async findByReportId(reportId: string) {
    return this.prisma.reportResult.findMany({
      where: { reportId },
      include: {
        reportMediaFiles: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async findLatestByReportId(reportId: string) {
    return this.prisma.reportResult.findFirst({
      where: { reportId },
      include: {
        reportMediaFiles: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async update(id: string, data: { description?: string; status?: string }) {
    return this.prisma.reportResult.update({
      where: { id },
      data,
    });
  }

  async updateStatus(id: string, status: string) {
    return this.prisma.reportResult.update({
      where: { id },
      data: { status },
    });
  }

  async addMediaFile(data: {
    reportResultId: string;
    fileUrl: string;
    stage: string;
    uploadedBy: string;
  }) {
    return this.prisma.reportMediaFile.create({
      data: {
        reportResultId: data.reportResultId,
        fileUrl: data.fileUrl,
        stage: data.stage,
        uploadedBy: data.uploadedBy,
      },
    });
  }
}

// Singleton instance
export const reportResultRepository = new ReportResultRepository();
