import { CAMPAIGN_ENDED_STATUSES, OWNER_ROLES } from "@da2/constants";
import prisma from "../../../config/prisma.client";
import { campaignManagerRepository } from "./campaign_manager.repository";
import { assertLeadersInTeam } from "./campaign-team";
import { reportRepository } from "../../report/report.repository";
import {
  AddCampaignManagersRequest,
  CampaignManagerAssignmentResponse,
  CampaignManagersListQuery,
} from "../campaign.dto";
import { campaignRepository } from "../campaign.repository";
import { HttpError, HTTP_STATUS } from "../../../constants/http-status";
import { organizationMemberRepository } from "../../organization/organization_member.repository";
import { campaignAccessService } from "../campaign-access.service";
import {
  fetchOrganizationOwnersByUserIds,
  getUserProfile,
} from "../../organization/identity-user.client";

export class CampaignManagerService {
  constructor() {}

  /** See `campaignAccessService`: creator, campaign manager or organization owner. */
  async canManageCampaign(
    campaignId: string,
    userId: string,
  ): Promise<boolean> {
    return campaignAccessService.canManage(campaignId, userId);
  }

  /** Managers must be active members of the organization that runs the campaign. */
  async assertAllMembers(organizationId: string, userIds: string[]): Promise<void> {
    const unique = [...new Set(userIds)];
    const members = await organizationMemberRepository.findActiveMemberUserIds(
      organizationId,
      unique,
    );
    if (members.size !== unique.length) {
      throw new HttpError(HTTP_STATUS.CAMPAIGN_MANAGER_NOT_MEMBER);
    }
  }

  /**
   * Spec 3.4: a manager leading shifts that have not ended is reassigned before being removed.
   * Owners stay on the team without a manager row, so they are never blocked.
   */
  async assertLeadsNoShifts(
    campaign: { id: string; organizationId: string; status: number },
    userIds: string[],
    now = new Date(),
  ): Promise<void> {
    if (userIds.length === 0 || CAMPAIGN_ENDED_STATUSES.includes(campaign.status)) return;
    const owners = await prisma.organizationMember.findMany({
      where: {
        organizationId: campaign.organizationId,
        userId: { in: userIds },
        deletedAt: null,
        role: { in: [...OWNER_ROLES] },
      },
      select: { userId: true },
    });
    const ownerIds = new Set(owners.map((o) => o.userId));
    const blocked = userIds.filter((id) => !ownerIds.has(id));
    if (blocked.length === 0) return;
    const shifts = await prisma.campaignShift.findMany({
      where: {
        campaignId: campaign.id,
        leaderUserId: { in: blocked },
        minVolunteers: { gt: 0 },
        endAt: { gt: now },
      },
      orderBy: { startAt: "asc" },
      select: {
        id: true,
        leaderUserId: true,
        startAt: true,
        meetingPoint: { select: { name: true, sortOrder: true } },
      },
    });
    if (shifts.length > 0) {
      throw new HttpError(HTTP_STATUS.CAMPAIGN_MANAGER_LEADS_SHIFTS, {
        details: {
          shifts: shifts.map((s) => ({
            shiftId: s.id,
            leaderUserId: s.leaderUserId,
            startAt: s.startAt,
            meetingPoint: s.meetingPoint.name || `#${s.meetingPoint.sortOrder + 1}`,
          })),
        },
      });
    }
  }

  /**
   * Spec 3.4: choose who leads a shift that has not ended. The leader must be on the campaign's
   * team; saved at once, with a log (spec 3.5).
   */
  async setShiftLeader(
    campaignId: string,
    shiftId: string,
    leaderUserId: string,
    actorId: string,
    now = new Date(),
  ): Promise<{ shiftId: string; leaderUserId: string }> {
    const campaign = await campaignRepository.findById(campaignId);
    if (!campaign) {
      throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"));
    }
    await campaignAccessService.assertCanManage(campaign, actorId);
    if (CAMPAIGN_ENDED_STATUSES.includes(campaign.status)) {
      throw new HttpError(HTTP_STATUS.CAMPAIGN_NOT_EDITABLE);
    }
    const shift = await prisma.campaignShift.findFirst({
      where: { id: shiftId, campaignId },
      select: { id: true, endAt: true, leaderUserId: true },
    });
    if (!shift) {
      throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Shift not found"));
    }
    if (shift.endAt.getTime() <= now.getTime()) {
      throw new HttpError(HTTP_STATUS.SHIFT_ALREADY_STARTED);
    }
    await assertLeadersInTeam(prisma, campaign, [leaderUserId]);
    if (shift.leaderUserId !== leaderUserId) {
      await prisma.$transaction([
        prisma.campaignShift.update({ where: { id: shiftId }, data: { leaderUserId } }),
        prisma.campaignStatusLog.create({
          data: {
            campaignId,
            type: "EDIT",
            event: "set_shift_leader",
            actorId,
            actorRole: "manager",
            reason: null,
            changes: { shiftId, leaderUserId: { from: shift.leaderUserId, to: leaderUserId } },
          },
        }),
      ]);
    }
    return { shiftId, leaderUserId };
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

    await campaignAccessService.assertCanManage(campaign, assignedBy);
    await this.assertAllMembers(campaign.organizationId, request.userIds);

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

    await campaignAccessService.assertCanManage(campaign, removedBy);
    if (campaign.createdBy === userId) {
      throw new HttpError(HTTP_STATUS.CANNOT_REMOVE_CAMPAIGN_CREATOR);
    }

    const existing = await campaignManagerRepository.findByCampaignIdAndUserId(
      campaignId,
      userId,
    );
    if (!existing) {
      throw new HttpError(HTTP_STATUS.NOT_A_MANAGER);
    }
    await this.assertLeadsNoShifts(campaign, [userId]);

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
