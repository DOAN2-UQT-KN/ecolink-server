import { Prisma } from "@prisma/client";
import prisma from "../../config/prisma.client";
import { HTTP_STATUS } from "../../constants/http-status";
import { rewardServiceClient } from "../reward/reward-service.client";
import { campaignRepository } from "./campaign.repository";
import {
  CampaignListQuery,
  CampaignResponse,
  CreateCampaignRequest,
  UpdateCampaignRequest,
} from "./campaign.dto";
import {
  CampaignWithReports,
  toCampaignResponse,
} from "./campaign.entity";

export class CampaignService {
  constructor() {}

  private async toResponse(
    entity: CampaignWithReports,
  ): Promise<CampaignResponse> {
    const tier = await rewardServiceClient.getDifficultyByLevel(
      entity.difficulty,
    );
    const greenPoints = tier?.greenPoints ?? 0;
    return toCampaignResponse(entity, greenPoints);
  }

  async createCampaign(
    userId: string,
    request: CreateCampaignRequest,
  ): Promise<CampaignResponse> {
    const tier = await rewardServiceClient.getDifficultyByLevel(
      request.difficulty,
    );
    if (!tier) {
      throw new Error(
        "Invalid campaign difficulty; no matching tier in reward service",
      );
    }

    const reportIds = this.normalizeReportIds(request.reportIds);
    const managerIds = [userId];
    await this.validateReportIds(reportIds);

    const created = await prisma.$transaction(
      async (tx) => {
        const campaign = await tx.campaign.create({
          data: {
            title: request.title,
            description: request.description,
            difficulty: request.difficulty,
            isVerify: false,
            createdBy: userId,
            updatedBy: userId,
          },
        });

        await this.assignManagersToCampaign(
          tx,
          campaign.id,
          managerIds,
          userId,
        );

        // Campaign ownership is manager ownership. Do not create report managers here.
        await this.assignReportsToCampaign(tx, campaign.id, reportIds);

        return tx.campaign.findFirst({
          where: { id: campaign.id, deletedAt: null },
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
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );

    if (!created) {
      throw new Error("Failed to create campaign");
    }

    return this.toResponse(created);
  }

  async getCampaignById(id: string): Promise<CampaignResponse | null> {
    const campaign = await campaignRepository.findById(id);
    return campaign ? this.toResponse(campaign) : null;
  }

  /** campaignIds limited to 100 UUIDs at the controller. */
  async getCampaignsByIds(campaignIds: string[]): Promise<CampaignResponse[]> {
    if (campaignIds.length === 0) {
      return [];
    }
    const rows = await campaignRepository.findManyByIds(campaignIds);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const difficulties = await rewardServiceClient.getDifficulties();
    const greenByLevel = new Map(
      difficulties.map((d) => [d.level, d.greenPoints]),
    );
    return campaignIds
      .map((id) => byId.get(id))
      .filter((row): row is CampaignWithReports => row !== undefined)
      .map((campaign) =>
        toCampaignResponse(
          campaign,
          greenByLevel.get(campaign.difficulty) ?? 0,
        ),
      );
  }

  async getCampaigns(query: CampaignListQuery): Promise<{
    campaigns: CampaignResponse[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const sortBy = query.sortBy ?? "createdAt";
    const sortOrder = query.sortOrder ?? "desc";
    const skip = (page - 1) * limit;

    const { rows, total } = await campaignRepository.findManyPaginated({
      filters: {
        search: query.search,
        status: query.status,
        createdBy: query.createdBy,
        managerId: query.managerId,
      },
      skip,
      take: limit,
      sortBy,
      sortOrder,
    });

    const difficulties = await rewardServiceClient.getDifficulties();
    const greenByLevel = new Map(
      difficulties.map((d) => [d.level, d.greenPoints]),
    );

    return {
      campaigns: rows.map((campaign) =>
        toCampaignResponse(
          campaign,
          greenByLevel.get(campaign.difficulty) ?? 0,
        ),
      ),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async updateCampaign(
    id: string,
    userId: string,
    request: UpdateCampaignRequest,
  ): Promise<CampaignResponse> {
    const existing = await campaignRepository.findById(id);
    if (!existing) {
      throw new Error("Campaign not found");
    }

    this.ensureOwner(existing.createdBy, userId);

    if (request.difficulty !== undefined) {
      const nextTier = await rewardServiceClient.getDifficultyByLevel(
        request.difficulty,
      );
      if (!nextTier) {
        throw new Error(
          "Invalid campaign difficulty; no matching tier in reward service",
        );
      }
    }

    const shouldUpdateReports = request.reportIds !== undefined;
    const reportIds = shouldUpdateReports
      ? this.normalizeReportIds(request.reportIds)
      : [];
    const shouldUpdateManagers = request.managerIds !== undefined;
    const managerIds = shouldUpdateManagers
      ? this.normalizeManagerIds(
          request.managerIds,
          existing.createdBy ?? userId,
        )
      : [];

    if (shouldUpdateReports) {
      await this.validateReportIds(reportIds);
    }

    const updated = await prisma.$transaction(
      async (tx) => {
        await tx.campaign.update({
          where: { id },
          data: {
            title: request.title,
            description: request.description,
            status: request.status,
            ...(request.difficulty !== undefined
              ? { difficulty: request.difficulty }
              : {}),
            updatedBy: userId,
          },
        });

        if (shouldUpdateReports) {
          await tx.report.updateMany({
            where: {
              campaignId: id,
              deletedAt: null,
            },
            data: {
              campaignId: null,
            },
          });

          await this.assignReportsToCampaign(tx, id, reportIds);
        }

        if (shouldUpdateManagers) {
          await this.syncManagersForCampaign(tx, id, managerIds, userId);
        }

        const campaign = await tx.campaign.findFirst({
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

        if (!campaign) {
          throw new Error("Campaign not found");
        }

        return campaign;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );

    return this.toResponse(updated);
  }

  /** Admin-only at controller: mark campaign as verified. */
  async adminVerifyCampaign(id: string): Promise<CampaignResponse> {
    const existing = await campaignRepository.findById(id);
    if (!existing) {
      throw new Error("Campaign not found");
    }

    const updated = await campaignRepository.update(id, {
      isVerify: true,
    });
    return this.toResponse(updated);
  }

  async deleteCampaign(id: string, userId: string): Promise<void> {
    const existing = await campaignRepository.findById(id);
    if (!existing) {
      throw new Error("Campaign not found");
    }

    this.ensureOwner(existing.createdBy, userId);

    await prisma.$transaction(async (tx) => {
      await tx.report.updateMany({
        where: {
          campaignId: id,
          deletedAt: null,
        },
        data: {
          campaignId: null,
        },
      });

      await tx.campaign.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          updatedBy: userId,
        },
      });
    });
  }

  private ensureOwner(ownerId: string | null, userId: string): void {
    if (!ownerId || ownerId !== userId) {
      throw new Error(
        HTTP_STATUS.FORBIDDEN.withMessage(
          "Only campaign manager can modify campaign",
        ).message,
      );
    }
  }

  private normalizeReportIds(reportIds?: string[]): string[] {
    if (!reportIds || reportIds.length === 0) {
      return [];
    }

    return [
      ...new Set(
        reportIds.map((id) => id.trim()).filter((id) => id.length > 0),
      ),
    ];
  }

  private normalizeManagerIds(
    managerIds: string[] | undefined,
    ownerId: string,
  ): string[] {
    const normalized = (managerIds ?? [])
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    // Owner is always the first manager.
    return [...new Set([ownerId, ...normalized])];
  }

  private async validateReportIds(reportIds: string[]): Promise<void> {
    if (reportIds.length === 0) {
      return;
    }

    const validIds = await campaignRepository.findValidReportIds(reportIds);
    if (validIds.length !== reportIds.length) {
      throw new Error("One or more reportIds are invalid");
    }
  }

  private async assignReportsToCampaign(
    tx: Prisma.TransactionClient,
    campaignId: string,
    reportIds: string[],
  ): Promise<void> {
    if (reportIds.length === 0) {
      return;
    }

    const result = await tx.report.updateMany({
      where: {
        id: { in: reportIds },
        deletedAt: null,
      },
      data: {
        campaignId,
      },
    });

    if (result.count !== reportIds.length) {
      throw new Error(
        "Some reports could not be linked to campaign due to concurrent updates",
      );
    }
  }

  private async assignManagersToCampaign(
    tx: Prisma.TransactionClient,
    campaignId: string,
    managerIds: string[],
    assignedBy: string,
  ): Promise<void> {
    for (const managerId of managerIds) {
      await tx.campaignManager.upsert({
        where: {
          campaignId_userId: {
            campaignId,
            userId: managerId,
          },
        },
        create: {
          campaignId,
          userId: managerId,
          assignedBy,
          createdBy: assignedBy,
          updatedBy: assignedBy,
        },
        update: {
          deletedAt: null,
          assignedBy,
          updatedBy: assignedBy,
        },
      });
    }
  }

  private async syncManagersForCampaign(
    tx: Prisma.TransactionClient,
    campaignId: string,
    managerIds: string[],
    assignedBy: string,
  ): Promise<void> {
    await tx.campaignManager.updateMany({
      where: {
        campaignId,
        deletedAt: null,
        userId: { notIn: managerIds },
      },
      data: {
        deletedAt: new Date(),
        updatedBy: assignedBy,
      },
    });

    await this.assignManagersToCampaign(tx, campaignId, managerIds, assignedBy);
  }
}

export const campaignService = new CampaignService();
