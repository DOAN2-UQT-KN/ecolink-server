import { PrismaClient } from "@prisma/client";
import prisma from "../../../config/prisma.client";
import { JoinRequestStatus } from "../../../constants/status.enum";

export class ReportVolunteerRepository {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = prisma;
  }

  // Join Request operations
  async createJoinRequest(data: { reportId: string; volunteerId: string }) {
    return this.prisma.reportJoiningRequest.create({
      data: {
        reportId: data.reportId,
        volunteerId: data.volunteerId,
        status: JoinRequestStatus.PENDING,
      },
    });
  }

  async findJoinRequestById(id: string) {
    return this.prisma.reportJoiningRequest.findFirst({
      where: { id, deletedAt: null },
    });
  }

  async findJoinRequestByIdWithReport(id: string) {
    return this.prisma.reportJoiningRequest.findFirst({
      where: { id, deletedAt: null },
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
    });
  }

  async findExistingJoinRequest(reportId: string, volunteerId: string) {
    return this.prisma.reportJoiningRequest.findFirst({
      where: {
        reportId,
        volunteerId,
        deletedAt: null,
      },
    });
  }

  async findJoinRequestsByReportId(reportId: string) {
    return this.prisma.reportJoiningRequest.findMany({
      where: { reportId, deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
  }

  async findJoinRequestsByVolunteerId(volunteerId: string) {
    return this.prisma.reportJoiningRequest.findMany({
      where: { volunteerId, deletedAt: null },
      include: {
        report: {
          select: {
            id: true,
            title: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async findPendingJoinRequestsByReportId(reportId: string) {
    return this.prisma.reportJoiningRequest.findMany({
      where: { reportId, status: JoinRequestStatus.PENDING, deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
  }

  async updateJoinRequestStatus(id: string, status: string) {
    return this.prisma.reportJoiningRequest.update({
      where: { id },
      data: { status },
    });
  }

  async softDeleteJoinRequest(id: string) {
    return this.prisma.reportJoiningRequest.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  // Check if volunteer is approved for a report
  async isVolunteerApproved(
    reportId: string,
    volunteerId: string,
  ): Promise<boolean> {
    const request = await this.prisma.reportJoiningRequest.findFirst({
      where: {
        reportId,
        volunteerId,
        status: JoinRequestStatus.APPROVED,
        deletedAt: null,
      },
    });
    return !!request;
  }

  // Get all approved volunteers for a report
  async getApprovedVolunteers(reportId: string) {
    return this.prisma.reportJoiningRequest.findMany({
      where: {
        reportId,
        status: JoinRequestStatus.APPROVED,
        deletedAt: null,
      },
    });
  }
}

// Singleton instance
export const reportVolunteerRepository = new ReportVolunteerRepository();
