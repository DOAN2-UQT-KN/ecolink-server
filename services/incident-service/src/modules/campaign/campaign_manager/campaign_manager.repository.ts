import { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../../../config/prisma.client";

export class CampaignManagerRepository {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = prisma;
  }

  async assignManager(data: {
    campaignId: string;
    userId: string;
    assignedBy: string;
  }) {
    return this.prisma.campaignManager.create({
      data: {
        campaignId: data.campaignId,
        userId: data.userId,
        assignedBy: data.assignedBy,
        createdBy: data.assignedBy,
        updatedBy: data.assignedBy,
      },
    });
  }

  async findByCampaignIdAndUserId(campaignId: string, userId: string) {
    return this.prisma.campaignManager.findFirst({
      where: {
        campaignId,
        userId,
        deletedAt: null,
      },
    });
  }

  async findManagersByCampaignId(campaignId: string) {
    return this.prisma.campaignManager.findMany({
      where: { campaignId, deletedAt: null },
      orderBy: { assignedAt: "desc" },
    });
  }

  async findManagersByCampaignIdPaginated(params: {
    campaignId: string;
    userId?: string;
    skip: number;
    take: number;
    sortBy: "assignedAt" | "userId" | "createdAt";
    sortOrder: "asc" | "desc";
  }) {
    const where: Prisma.CampaignManagerWhereInput = {
      campaignId: params.campaignId,
      deletedAt: null,
      ...(params.userId ? { userId: params.userId } : {}),
    };

    const orderBy: Prisma.CampaignManagerOrderByWithRelationInput =
      params.sortBy === "userId"
        ? { userId: params.sortOrder }
        : params.sortBy === "createdAt"
          ? { createdAt: params.sortOrder }
          : { assignedAt: params.sortOrder };

    const [rows, total] = await Promise.all([
      this.prisma.campaignManager.findMany({
        where,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.campaignManager.count({ where }),
    ]);
    return { rows, total };
  }

  async findCampaignsByManagerId(userId: string) {
    return this.prisma.campaignManager.findMany({
      where: { userId, deletedAt: null },
      include: {
        campaign: {
          select: {
            id: true,
            title: true,
            status: true,
          },
        },
      },
      orderBy: { assignedAt: "desc" },
    });
  }

  async removeManager(campaignId: string, userId: string, removedBy: string) {
    return this.prisma.campaignManager.update({
      where: {
        campaignId_userId: { campaignId, userId },
      },
      data: { deletedAt: new Date(), updatedBy: removedBy },
    });
  }

  async isManager(campaignId: string, userId: string): Promise<boolean> {
    const manager = await this.findByCampaignIdAndUserId(campaignId, userId);
    return !!manager;
  }

  async assignMultipleManagers(data: {
    campaignId: string;
    userIds: string[];
    assignedBy: string;
  }) {
    const assignments = data.userIds.map((userId) => ({
      campaignId: data.campaignId,
      userId,
      assignedBy: data.assignedBy,
      createdBy: data.assignedBy,
      updatedBy: data.assignedBy,
    }));

    return this.prisma.campaignManager.createMany({
      data: assignments,
      skipDuplicates: true, // Skip if already exists
    });
  }
}

// Singleton instance
export const campaignManagerRepository = new CampaignManagerRepository();
