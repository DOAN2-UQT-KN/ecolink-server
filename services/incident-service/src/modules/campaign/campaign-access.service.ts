import { OrgPermission, hasOrgPermission } from "@da2/constants";
import { HTTP_STATUS, HttpError } from "../../constants/http-status";
import { organizationMemberRepository } from "../organization/organization_member.repository";
import { campaignRepository } from "./campaign.repository";
import { campaignManagerRepository } from "./campaign_manager/campaign_manager.repository";
import { campaignJoiningRequestRepository } from "./campaign_joining_request/campaign_joining_request.repository";

/** What the access rules need to know about a campaign. */
export interface CampaignAccessTarget {
  id: string;
  organizationId: string;
  createdBy: string | null;
}

export interface CampaignAccess {
  isCreator: boolean;
  isManager: boolean;
  /** The viewer's active role in the campaign's organization, or null. */
  orgRole: string | null;
  /** Edit, tasks, join requests, attendance, submissions, managers, SOS. */
  canManage: boolean;
  canDelete: boolean;
}

const NO_ACCESS: CampaignAccess = {
  isCreator: false,
  isManager: false,
  orgRole: null,
  canManage: false,
  canDelete: false,
};

/** Platform admin, from the JWT role (there is no shared middleware for it). */
export function isPlatformAdmin(role?: string | null): boolean {
  return role?.toLowerCase() === "admin";
}

/**
 * The one place that decides who may manage a campaign: its creator, a campaign manager, or
 * an owner of its organization (`CAMPAIGN_MANAGE_ANY`). Creator and manager rights only hold
 * while the person is still an active member of the organization, so leaving it ends them.
 * Deleting needs the creator or an owner.
 */
export class CampaignAccessService {
  compute(
    campaign: CampaignAccessTarget,
    userId: string,
    orgRole: string | null,
    isManager: boolean,
  ): CampaignAccess {
    if (!orgRole) return NO_ACCESS;
    const isCreator = campaign.createdBy === userId;
    const manageAny = hasOrgPermission(orgRole, OrgPermission.CAMPAIGN_MANAGE_ANY);
    return {
      isCreator,
      isManager,
      orgRole,
      canManage: isCreator || isManager || manageAny,
      canDelete: isCreator || manageAny,
    };
  }

  async resolve(
    campaignOrId: CampaignAccessTarget | string,
    userId: string | null | undefined,
  ): Promise<CampaignAccess> {
    if (!userId) return NO_ACCESS;
    const campaign = await this.load(campaignOrId);
    if (!campaign) return NO_ACCESS;
    const [orgRole, isManager] = await Promise.all([
      organizationMemberRepository.findActiveRole(campaign.organizationId, userId),
      campaignManagerRepository.isManager(campaign.id, userId),
    ]);
    return this.compute(campaign, userId, orgRole, isManager);
  }

  /**
   * Access for a list of campaigns in two queries. `managerIdsByCampaign` is what the list
   * query already loaded (active managers of each campaign).
   */
  async resolveMany(
    campaigns: Array<CampaignAccessTarget & { managerIds: string[] }>,
    userId: string | null | undefined,
  ): Promise<Map<string, CampaignAccess>> {
    const result = new Map<string, CampaignAccess>();
    if (!userId || campaigns.length === 0) return result;
    const roles = await organizationMemberRepository.findActiveRolesForUser(userId, [
      ...new Set(campaigns.map((c) => c.organizationId)),
    ]);
    for (const campaign of campaigns) {
      result.set(
        campaign.id,
        this.compute(
          campaign,
          userId,
          roles.get(campaign.organizationId) ?? null,
          campaign.managerIds.includes(userId),
        ),
      );
    }
    return result;
  }

  async canManage(campaignOrId: CampaignAccessTarget | string, userId: string) {
    return (await this.resolve(campaignOrId, userId)).canManage;
  }

  /** Throws 404 when the campaign does not exist, 403 when the caller may not manage it. */
  async assertCanManage(
    campaignOrId: CampaignAccessTarget | string,
    userId: string | null | undefined,
  ): Promise<CampaignAccessTarget> {
    const campaign = await this.loadOrThrow(campaignOrId);
    if (!(await this.resolve(campaign, userId)).canManage) {
      throw new HttpError(HTTP_STATUS.CAMPAIGN_PERMISSION_DENIED);
    }
    return campaign;
  }

  async assertCanDelete(
    campaignOrId: CampaignAccessTarget | string,
    userId: string | null | undefined,
  ): Promise<CampaignAccessTarget> {
    const campaign = await this.loadOrThrow(campaignOrId);
    if (!(await this.resolve(campaign, userId)).canDelete) {
      throw new HttpError(HTTP_STATUS.CAMPAIGN_PERMISSION_DENIED);
    }
    return campaign;
  }

  /** The approved-volunteer list: people managing the campaign, its volunteers, admins. */
  async assertCanViewVolunteers(
    campaignId: string,
    userId: string | null | undefined,
    role?: string | null,
  ): Promise<void> {
    const campaign = await this.loadOrThrow(campaignId);
    if (isPlatformAdmin(role)) return;
    if (!userId) throw new HttpError(HTTP_STATUS.CAMPAIGN_PERMISSION_DENIED);
    if ((await this.resolve(campaign, userId)).canManage) return;
    if (await campaignJoiningRequestRepository.isVolunteerApproved(campaign.id, userId)) {
      return;
    }
    throw new HttpError(HTTP_STATUS.CAMPAIGN_PERMISSION_DENIED);
  }

  private async load(
    campaignOrId: CampaignAccessTarget | string,
  ): Promise<CampaignAccessTarget | null> {
    if (typeof campaignOrId !== "string") return campaignOrId;
    const campaign = await campaignRepository.findById(campaignOrId);
    return campaign
      ? {
          id: campaign.id,
          organizationId: campaign.organizationId,
          createdBy: campaign.createdBy,
        }
      : null;
  }

  private async loadOrThrow(
    campaignOrId: CampaignAccessTarget | string,
  ): Promise<CampaignAccessTarget> {
    const campaign = await this.load(campaignOrId);
    if (!campaign) {
      throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"));
    }
    return campaign;
  }
}

export const campaignAccessService = new CampaignAccessService();
