import { PrismaClient, Prisma } from "@prisma/client";
import prisma from "../../../config/prisma.client";

export class ReportTaskRepository {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = prisma;
  }

  async create(data: Prisma.ReportTaskCreateInput) {
    return this.prisma.reportTask.create({ data });
  }

  async findById(id: string) {
    return this.prisma.reportTask.findFirst({
      where: { id, deletedAt: null },
    });
  }

  async findByIdWithAssignments(id: string) {
    return this.prisma.reportTask.findFirst({
      where: { id, deletedAt: null },
      include: {
        taskAssignments: {
          where: { deletedAt: null },
        },
      },
    });
  }

  async findByReportId(reportId: string) {
    return this.prisma.reportTask.findMany({
      where: { reportId, deletedAt: null },
      include: {
        taskAssignments: {
          where: { deletedAt: null },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async update(id: string, data: Prisma.ReportTaskUpdateInput) {
    return this.prisma.reportTask.update({
      where: { id },
      data,
    });
  }

  async softDelete(id: string) {
    return this.prisma.reportTask.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  // Task Assignment operations
  async createAssignment(data: { reportTaskId: string; volunteerId: string }) {
    return this.prisma.taskAssignment.create({
      data: {
        reportTaskId: data.reportTaskId,
        volunteerId: data.volunteerId,
      },
    });
  }

  async findAssignment(taskId: string, volunteerId: string) {
    return this.prisma.taskAssignment.findFirst({
      where: {
        reportTaskId: taskId,
        volunteerId,
        deletedAt: null,
      },
    });
  }

  async findAssignmentsByTaskId(taskId: string) {
    return this.prisma.taskAssignment.findMany({
      where: { reportTaskId: taskId, deletedAt: null },
    });
  }

  async findAssignmentsByVolunteerId(volunteerId: string) {
    return this.prisma.taskAssignment.findMany({
      where: { volunteerId, deletedAt: null },
      include: {
        reportTask: {
          include: {
            report: {
              select: {
                id: true,
                title: true,
                status: true,
              },
            },
          },
        },
      },
    });
  }

  async removeAssignment(id: string) {
    return this.prisma.taskAssignment.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}

// Singleton instance
export const reportTaskRepository = new ReportTaskRepository();
