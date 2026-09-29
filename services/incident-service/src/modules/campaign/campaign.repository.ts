import { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../../config/prisma.client";
import { GlobalStatus, ReportStatus } from "../../constants/status.enum";
import { CAMPAIGN_PUBLIC_STATUSES, OWNER_ROLES } from "@da2/constants";
import { CAMPAIGN_INCLUDE, CampaignWithReports } from "./campaign.entity";

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
      include: CAMPAIGN_INCLUDE,
    });
  }

  async findById(id: string): Promise<CampaignWithReports | null> {
    return this.prisma.campaign.findFirst({
      where: { id, deletedAt: null },
      include: CAMPAIGN_INCLUDE,
    });
  }

  async findManyByIds(ids: string[]): Promise<CampaignWithReports[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.prisma.campaign.findMany({
      where: { id: { in: ids }, deletedAt: null },
      include: CAMPAIGN_INCLUDE,
    });
  }

  private static readonly listInclude = CAMPAIGN_INCLUDE;

  async findManyPaginated(params: {
    filters: {
      search?: string;
      status?: number;
      statuses?: number[];
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
      isOwner?: boolean;
      excludeMemberOrgsOfUserId?: string;
      publicOnly?: boolean;
    };
    skip: number;
    take: number;
    sortBy: "createdAt" | "updatedAt" | "title";
    sortOrder: "asc" | "desc";
  }): Promise<{ rows: CampaignWithReports[]; total: number }> {
    const { filters, skip, take, sortBy, sortOrder } = params;

    const statusFilter: Prisma.CampaignWhereInput =
      filters.statuses && filters.statuses.length > 0
        ? { status: { in: filters.statuses } }
        : filters.status !== undefined
          ? { status: filters.status }
          : {};
    const where: Prisma.CampaignWhereInput = {
      deletedAt: null,
      AND: [
        statusFilter,
        filters.publicOnly
          ? { status: { in: [...CAMPAIGN_PUBLIC_STATUSES] } }
          : {},
        filters.excludeMemberOrgsOfUserId
          ? {
              organization: {
                members: {
                  none: {
                    userId: filters.excludeMemberOrgsOfUserId,
                    deletedAt: null,
                  },
                },
              },
            }
          : {},
      ],
      ...(filters.createdBy ? { createdBy: filters.createdBy } : {}),
      ...(filters.organizationId
        ? { organizationId: filters.organizationId }
        : {}),
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
        ? filters.isOwner
          ? {
              // Campaigns I run: created, managed, or of an organization I own
              // (owners may manage every campaign of their organization).
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
                  organization: {
                    members: {
                      some: {
                        userId: filters.myCampaignsUserId,
                        deletedAt: null,
                        role: { in: [...OWNER_ROLES] },
                      },
                    },
                  },
                },
              ],
            }
          : {
              OR: [
                {
                  AND: [
                    {
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
                      ],
                    },
                    { status: GlobalStatus._STATUS_ACTIVE },
                  ],
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

  /** All non-deleted campaigns with status ACTIVE (no pagination). */
  async findAllActive(params: {
    sortBy: "createdAt" | "updatedAt" | "title";
    sortOrder: "asc" | "desc";
  }): Promise<CampaignWithReports[]> {
    const { sortBy, sortOrder } = params;
    const orderBy: Prisma.CampaignOrderByWithRelationInput =
      sortBy === "title"
        ? { title: sortOrder }
        : sortBy === "updatedAt"
          ? { updatedAt: sortOrder }
          : { createdAt: sortOrder };

    return this.prisma.campaign.findMany({
      where: {
        deletedAt: null,
        status: GlobalStatus._STATUS_ACTIVE,
      },
      include: CampaignRepository.listInclude,
      orderBy,
    });
  }

  async update(
    id: string,
    data: Prisma.CampaignUpdateInput,
  ): Promise<CampaignWithReports> {
    return this.prisma.campaign.update({
      where: { id },
      data,
      include: CAMPAIGN_INCLUDE,
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
      include: CAMPAIGN_INCLUDE,
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
