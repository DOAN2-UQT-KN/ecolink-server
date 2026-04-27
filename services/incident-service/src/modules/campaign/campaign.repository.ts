import { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../../config/prisma.client";
import { GlobalStatus, ReportStatus } from "../../constants/status.enum";
import { CampaignWithReports } from "./campaign.entity";

const SUBMISSION_STATUSES_AWAITING_REVIEW: number[] = [
  GlobalStatus._STATUS_INREVIEW,
  GlobalStatus._STATUS_WAITING_APPROVED,
  GlobalStatus._STATUS_PENDING,
];

import { JoinRequestStatus } from "../../constants/status.enum";

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
      organizationId?: string;
      latitude?: number;
      longitude?: number;
      radiusKm?: number;
      difficulty?: number;
      difficultyLevels?: number[];
      myCampaignsUserId?: string;
      excludeMyCampaignsUserId?: string;
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
      ...(filters.difficultyLevels && filters.difficultyLevels.length > 0
        ? { difficulty: { in: filters.difficultyLevels } }
        : {}),
      ...(filters.myCampaignsUserId
        ? {
            OR: [
              { createdBy: filters.myCampaignsUserId },
              {
                campaignManagers: {
                  some: {
                    userId: filters.myCampaignsUserId,
                    deletedAt: null,
                  },
                },
              },
              {
                campaignJoiningRequests: {
                  some: {
                    volunteerId: filters.myCampaignsUserId,
                    status: JoinRequestStatus._STATUS_APPROVED,
                    deletedAt: null,
                  },
                },
              },
            ],
          }
        : {}),
      ...(filters.excludeMyCampaignsUserId
        ? {
            NOT: {
              OR: [
                { createdBy: filters.excludeMyCampaignsUserId },
                {
                  campaignManagers: {
                    some: {
                      userId: filters.excludeMyCampaignsUserId,
                      deletedAt: null,
                    },
                  },
                },
                {
                  campaignJoiningRequests: {
                    some: {
                      volunteerId: filters.excludeMyCampaignsUserId,
                      status: JoinRequestStatus._STATUS_APPROVED,
                      deletedAt: null,
                    },
                  },
                },
              ],
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
        campaignId: null,
        status: ReportStatus._STATUS_TODO,
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

  /**
   * Campaigns with more than one submission still awaiting manager approve/reject
   * (in review / legacy waiting-approved / pending).
   */
  async findCampaignIdsWithMultipleAwaitingSubmissions(): Promise<
    { campaignId: string; awaitingSubmissionCount: number }[]
  > {
    const rows = await this.prisma.campaignSubmission.groupBy({
      by: ["campaignId"],
      where: {
        deletedAt: null,
        status: { in: SUBMISSION_STATUSES_AWAITING_REVIEW },
        campaign: { deletedAt: null },
      },
      _count: { id: true },
      having: {
        id: { _count: { gt: 1 } },
      },
    });
    return rows.map((r) => ({
      campaignId: r.campaignId,
      awaitingSubmissionCount: r._count.id,
    }));
  }

}

export const campaignRepository = new CampaignRepository();
