import { campaignManagerRepository } from "./campaign_manager.repository";
import { reportRepository } from "../../report/report.repository";
import {
  AddCampaignManagersRequest,
  CampaignManagerAssignmentResponse,
  CampaignManagersListQuery,
} from "../campaign.dto";
import { campaignRepository } from "../campaign.repository";
import { HttpError, HTTP_STATUS } from "../../../constants/http-status";
import {
  fetchOrganizationOwnersByUserIds,
  getUserProfile,
} from "../../organization/identity-user.client";

export class CampaignManagerService {
  constructor() {}

  /**
   * Campaign creator or a campaign manager may manage the campaign (tasks,
   * manager roster, assignments, etc.).
   */
  async canManageCampaign(
    campaignId: string,
    userId: string,
  ): Promise<boolean> {
    const campaign = await campaignRepository.findById(campaignId);
    if (!campaign) {
      return false;
    }

    if (campaign.createdBy === userId) {
      return true;
    }

    return campaignManagerRepository.isManager(campaignId, userId);
  }

  /**
   * Add multiple managers to a campaign.
   * Only the campaign creator or existing campaign managers may add managers.
   */
  async addManagers(
    campaignId: string,
    request: AddCampaignManagersRequest,
    assignedBy: string,
  ): Promise<CampaignManagerAssignmentResponse[]> {
    const campaign = await campaignRepository.findById(campaignId);
    if (!campaign) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"),
      );
    }

    const canManage = await this.canManageCampaign(campaignId, assignedBy);
    if (!canManage) {
      throw new HttpError(
        HTTP_STATUS.FORBIDDEN.withMessage(
          "Only the campaign creator or campaign managers can assign managers",
        ),
      );
    }

    const addedManagers: CampaignManagerAssignmentResponse[] = [];

    for (const userId of request.userIds) {
      const existing =
        await campaignManagerRepository.findByCampaignIdAndUserId(
          campaignId,
          userId,
        );
      if (existing) {
        continue;
      }

      const manager = await campaignManagerRepository.assignManager({
        campaignId,
        userId,
        assignedBy,
      });

      addedManagers.push({
        campaignId,
        userId: manager.userId,
        name: "",
        avatar: null,
        assignedBy: manager.assignedBy,
        assignedAt: manager.assignedAt,
      });
    }

    // Enrich all newly added managers with identity-service profiles in one batch.
    const profileMap = await fetchOrganizationOwnersByUserIds(
      addedManagers.map((m) => m.userId),
    );
    return addedManagers.map((m) => {
      const profile = getUserProfile(profileMap, m.userId);
      return {
        ...m,
        name: profile?.name ?? "",
        avatar: profile?.avatar ?? null,
      };
    });
  }

  /**
   * Remove a manager from a campaign.
   * Only the campaign creator or a campaign manager may remove managers.
   */
  async removeManager(
    campaignId: string,
    userId: string,
    removedBy: string,
  ): Promise<void> {
    const campaign = await campaignRepository.findById(campaignId);
    if (!campaign) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"),
      );
    }

    const canRemove = await this.canManageCampaign(campaignId, removedBy);
    if (!canRemove) {
      throw new HttpError(
        HTTP_STATUS.FORBIDDEN.withMessage(
          "Only the campaign creator or campaign managers can remove managers",
        ),
      );
    }

    const existing = await campaignManagerRepository.findByCampaignIdAndUserId(
      campaignId,
      userId,
    );
    if (!existing) {
      throw new HttpError(HTTP_STATUS.NOT_A_MANAGER);
    }

    await campaignManagerRepository.removeManager(
      campaignId,
      userId,
      removedBy,
    );
  }

  /**
   * Check if user is campaign manager for the campaign that owns the report.
   */
  async isManager(reportId: string, userId: string): Promise<boolean> {
    const report = await reportRepository.findById(reportId);
    if (!report?.campaignId) {
      return false;
    }

    return campaignManagerRepository.isManager(report.campaignId, userId);
  }

  /**
   * Check if user can manage a report (is reporter or campaign manager).
   */
  async canManageReport(reportId: string, userId: string): Promise<boolean> {
    const report = await reportRepository.findById(reportId);
    if (!report) {
      return false;
    }

    if (report.userId === userId) {
      return true;
    }

    if (!report.campaignId) {
      return false;
    }

    return campaignManagerRepository.isManager(report.campaignId, userId);
  }

  /**
   * List manager assignments for a campaign with optional filters and pagination.
   */
  async listManagers(
    campaignId: string,
    query: CampaignManagersListQuery,
  ): Promise<{
    managers: CampaignManagerAssignmentResponse[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const campaign = await campaignRepository.findById(campaignId);
    if (!campaign) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"),
      );
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const sortBy = query.sortBy ?? "assignedAt";
    const sortOrder = query.sortOrder ?? "desc";
    const skip = (page - 1) * limit;

    const { rows, total } =
      await campaignManagerRepository.findManagersByCampaignIdPaginated({
        campaignId,
        userId: query.userId,
        skip,
        take: limit,
        sortBy,
        sortOrder,
      });

    // Enrich managers with name / avatar from identity-service.
    const profileMap = await fetchOrganizationOwnersByUserIds(
      rows.map((m) => m.userId),
    );

    return {
      managers: rows.map((m) => {
        const profile = getUserProfile(profileMap, m.userId);
        return {
          campaignId,
          userId: m.userId,
          name: profile?.name ?? "",
          avatar: profile?.avatar ?? null,
          assignedBy: m.assignedBy,
          assignedAt: m.assignedAt,
        };
      }),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get all campaigns managed by a user.
   */
  async getMyManagedCampaigns(userId: string) {
    const managers =
      await campaignManagerRepository.findCampaignsByManagerId(userId);

    return managers.map((m) => ({
      campaignId: m.campaignId,
      userId: m.userId,
      assignedBy: m.assignedBy,
      assignedAt: m.assignedAt,
      createdAt: m.createdAt,
      campaign: m.campaign
        ? {
            id: m.campaign.id,
            title: m.campaign.title,
            status: m.campaign.status,
          }
        : undefined,
    }));
  }
}

// Singleton instance
export const campaignManagerService = new CampaignManagerService();
