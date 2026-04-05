import { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../../config/prisma.client";
import { CampaignWithReports } from "./campaign.entity";

export class CampaignRepository {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = prisma;
  }

  async create(data: Prisma.CampaignCreateInput): Promise<CampaignWithReports> {
    return this.prisma.campaign.create({
      data,
      include: {
        campaignManagers: {
          where: { deletedAt: null },
          select: { userId: true },
        },
        reports: {
          where: { deletedAt: null },
          select: { id: true },
        },
      },
    });
  }

  async findById(id: string): Promise<CampaignWithReports | null> {
    return this.prisma.campaign.findFirst({
      where: { id, deletedAt: null },
      include: {
        campaignManagers: {
          where: { deletedAt: null },
          select: { userId: true },
        },
        reports: {
          where: { deletedAt: null },
          select: { id: true },
        },
      },
    });
  }

  async findManyByIds(ids: string[]): Promise<CampaignWithReports[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.prisma.campaign.findMany({
      where: { id: { in: ids }, deletedAt: null },
      include: {
        campaignManagers: {
          where: { deletedAt: null },
          select: { userId: true },
        },
        reports: {
          where: { deletedAt: null },
          select: { id: true },
        },
      },
    });
  }

  private static readonly listInclude = {
    campaignManagers: {
      where: { deletedAt: null },
      select: { userId: true },
    },
    reports: {
      where: { deletedAt: null },
      select: { id: true },
    },
  } as const;

  async findManyPaginated(params: {
    filters: {
      search?: string;
      status?: number;
      createdBy?: string;
      managerId?: string;
    };
    skip: number;
    take: number;
    sortBy: "createdAt" | "updatedAt" | "title";
    sortOrder: "asc" | "desc";
  }): Promise<{ rows: CampaignWithReports[]; total: number }> {
    const { filters, skip, take, sortBy, sortOrder } = params;

    const where: Prisma.CampaignWhereInput = {
      deletedAt: null,
      ...(filters.status !== undefined ? { status: filters.status } : {}),
      ...(filters.createdBy ? { createdBy: filters.createdBy } : {}),
      ...(filters.search
        ? {
            title: {
              contains: filters.search,
              mode: Prisma.QueryMode.insensitive,
            },
          }
        : {}),
      ...(filters.managerId
        ? {
            campaignManagers: {
              some: {
                userId: filters.managerId,
                deletedAt: null,
              },
            },
          }
        : {}),
    };

    const orderBy: Prisma.CampaignOrderByWithRelationInput =
      sortBy === "title"
        ? { title: sortOrder }
        : sortBy === "updatedAt"
          ? { updatedAt: sortOrder }
          : { createdAt: sortOrder };

    const include = CampaignRepository.listInclude;

    const [rows, total] = await Promise.all([
      this.prisma.campaign.findMany({
        where,
        include,
        orderBy,
        skip,
        take,
      }),
      this.prisma.campaign.count({ where }),
    ]);

    return { rows, total };
  }

  async update(
    id: string,
    data: Prisma.CampaignUpdateInput,
  ): Promise<CampaignWithReports> {
    return this.prisma.campaign.update({
      where: { id },
      data,
      include: {
        campaignManagers: {
          where: { deletedAt: null },
          select: { userId: true },
        },
        reports: {
          where: { deletedAt: null },
          select: { id: true },
        },
      },
    });
  }

  async softDelete(
    id: string,
    deletedBy: string,
  ): Promise<CampaignWithReports> {
    return this.prisma.campaign.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        updatedBy: deletedBy,
      },
      include: {
        campaignManagers: {
          where: { deletedAt: null },
          select: { userId: true },
        },
        reports: {
          where: { deletedAt: null },
          select: { id: true },
        },
      },
    });
  }

  async findValidReportIds(reportIds: string[]): Promise<string[]> {
    if (reportIds.length === 0) {
      return [];
    }

    const reports = await this.prisma.report.findMany({
      where: {
        id: { in: reportIds },
        deletedAt: null,
      },
      select: { id: true },
    });

    return reports.map((report) => report.id);
  }

  async clearCampaignReports(campaignId: string): Promise<void> {
    await this.prisma.report.updateMany({
      where: {
        campaignId,
        deletedAt: null,
      },
      data: {
        campaignId: null,
      },
    });
  }

  async assignReports(campaignId: string, reportIds: string[]): Promise<void> {
    if (reportIds.length === 0) {
      return;
    }

    await this.prisma.report.updateMany({
      where: {
        id: { in: reportIds },
        deletedAt: null,
      },
      data: {
        campaignId,
      },
    });
  }

  async unassignReports(campaignId: string): Promise<void> {
    await this.prisma.report.updateMany({
      where: {
        campaignId,
        deletedAt: null,
      },
      data: {
        campaignId: null,
      },
    });
  }

}

export const campaignRepository = new CampaignRepository();
