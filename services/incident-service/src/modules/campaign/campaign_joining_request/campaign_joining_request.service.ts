import { rewardServiceClient } from "../../reward/reward-service.client";
import {
  fetchOrganizationOwnersByUserIds,
  getUserProfile,
} from "../../organization/identity-user.client";
import type { OrganizationOwnerResponse } from "../../organization/organization.dto";
import { campaignJoiningRequestRepository } from "./campaign_joining_request.repository";
import { campaignAttendanceRepository } from "../campaign_attendance/campaign_attendance.repository";
import { campaignRepository } from "../campaign.repository";
import { campaignManagerRepository } from "../campaign_manager/campaign_manager.repository";
import {
  GlobalStatus,
  JoinRequestStatus,
} from "../../../constants/status.enum";
import type {
  CampaignJoinRequestDetailResponse,
  CampaignJoinRequestResponse,
  GetApprovedVolunteersQuery,
  GetJoinRequestsQuery,
  MyJoinRequestsQuery,
} from "../campaign.dto";

export type JoinRequestResponse = CampaignJoinRequestResponse;
export type JoinRequestDetailResponse = CampaignJoinRequestDetailResponse;

export type ProcessJoinRequestResult =
  | { type: "approved"; joinRequest: JoinRequestResponse }
  | { type: "rejected"; requestId: string };

export interface CreateJoinRequestRequest {
  campaignId: string;
}

export interface UpdateJoinRequestRequest {
  status: GlobalStatus._STATUS_APPROVED | GlobalStatus._STATUS_REJECTED;
}

export class CampaignJoiningRequestService {
  constructor() {}

  /**
   * Create a join request for a campaign.
   */
  async createJoinRequest(
    campaignId: string,
    volunteerId: string,
  ): Promise<JoinRequestResponse> {
    const campaign = await campaignRepository.findById(campaignId);
    if (!campaign) {
      throw new Error("Campaign not found");
    }

    const existing = await campaignJoiningRequestRepository.findExisting(
      campaignId,
      volunteerId,
    );
    if (existing) {
      throw new Error("Join request already exists");
    }

    const request = await campaignJoiningRequestRepository.createJoinRequest({
      campaignId,
      volunteerId,
    });

    const profileMap = await fetchOrganizationOwnersByUserIds([volunteerId]);
    return this.toResponse(request, profileMap);
  }

  /**
   * Get a join request by ID.
   */
  async getJoinRequestById(
    id: string,
  ): Promise<JoinRequestDetailResponse | null> {
    const request =
      await campaignJoiningRequestRepository.findByIdWithCampaign(id);
    if (!request) return null;
    const volunteerId = request.volunteerId;
    const profileMap = volunteerId
      ? await fetchOrganizationOwnersByUserIds([volunteerId])
      : new Map<string, OrganizationOwnerResponse>();
    return this.toDetailResponse(request, profileMap);
  }

  /**
   * List join requests for a campaign with filters and pagination (managers only).
   */
  async getJoinRequestsByCampaignForManager(
    campaignId: string,
    managerId: string,
    query: GetJoinRequestsQuery,
  ): Promise<{
    joinRequests: JoinRequestResponse[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const isManager = await campaignManagerRepository.isManager(
      campaignId,
      managerId,
    );
    if (!isManager) {
      throw new Error("Only campaign managers can view join requests");
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const sortBy = query.sortBy ?? "createdAt";
    const sortOrder = query.sortOrder ?? "desc";
    const skip = (page - 1) * limit;

    const { rows, total } =
      await campaignJoiningRequestRepository.findByCampaignIdPaginated(
        campaignId,
        {
          status: query.status,
          volunteerId: query.volunteerId,
        },
        { skip, take: limit, sortBy, sortOrder },
      );

    const volunteerIds = [
      ...new Set(
        rows
          .map((r) => r.volunteerId)
          .filter((id): id is string => id != null && id.length > 0),
      ),
    ];
    const profileMap = await fetchOrganizationOwnersByUserIds(volunteerIds);

    return {
      joinRequests: rows.map((r) => this.toResponse(r, profileMap)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * List my join requests (volunteer) with optional filters and pagination.
   */
  async getMyJoinRequests(
    volunteerId: string,
    query: MyJoinRequestsQuery,
  ): Promise<{
    joinRequests: JoinRequestDetailResponse[];
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

    const { rows, total } =
      await campaignJoiningRequestRepository.findByVolunteerIdPaginated(
        volunteerId,
        {
          campaignId: query.campaignId,
          status: query.status,
        },
        { skip, take: limit, sortBy, sortOrder },
      );

    const profileMap = await fetchOrganizationOwnersByUserIds([volunteerId]);

    return {
      joinRequests: rows.map((r) => this.toDetailResponse(r, profileMap)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Approve a join request, or decline by soft-deleting it (no REJECTED row).
   * Only campaign managers can process join requests.
   */
  async processJoinRequest(
    requestId: string,
    managerId: string,
    status: GlobalStatus._STATUS_APPROVED | GlobalStatus._STATUS_REJECTED,
  ): Promise<ProcessJoinRequestResult> {
    const request =
      await campaignJoiningRequestRepository.findByIdWithCampaign(requestId);
    if (!request) {
      throw new Error("Join request not found");
    }

    if (!request.campaignId) {
      throw new Error("Join request has no associated campaign");
    }

    const isManager = await campaignManagerRepository.isManager(
      request.campaignId,
      managerId,
    );
    if (!isManager) {
      throw new Error(
        "Only campaign managers can approve/reject join requests",
      );
    }

    if (request.status !== JoinRequestStatus._STATUS_PENDING) {
      throw new Error("Join request already processed");
    }

    if (status === JoinRequestStatus._STATUS_APPROVED) {
      const difficulty = request.campaign?.difficulty;
      if (difficulty === undefined || difficulty === null) {
        throw new Error("Campaign difficulty missing");
      }
      const approvedCount =
        await campaignJoiningRequestRepository.countApprovedByCampaignId(
          request.campaignId,
        );
      await rewardServiceClient.assertCampaignHasCapacityForJoinApproval(
        approvedCount,
        difficulty,
      );
      const updated = await campaignJoiningRequestRepository.updateStatus(
        requestId,
        status,
      );
      const vid = updated.volunteerId;
      const profileMap = vid
        ? await fetchOrganizationOwnersByUserIds([vid])
        : new Map<string, OrganizationOwnerResponse>();
      return {
        type: "approved",
        joinRequest: this.toResponse(updated, profileMap),
      };
    }

    await campaignJoiningRequestRepository.softDelete(requestId);
    return { type: "rejected", requestId };
  }

  /**
   * Cancel a join request (by the volunteer who created it).
   */
  async cancelJoinRequest(
    requestId: string,
    volunteerId: string,
  ): Promise<void> {
    const request = await campaignJoiningRequestRepository.findById(requestId);
    if (!request) {
      throw new Error("Join request not found");
    }

    if (request.volunteerId !== volunteerId) {
      throw new Error("Cannot cancel another user's join request");
    }

    if (request.status !== JoinRequestStatus._STATUS_PENDING) {
      throw new Error("Can only cancel pending requests");
    }

    await campaignJoiningRequestRepository.softDelete(requestId);
  }

  /**
   * Check if a volunteer is approved for a campaign.
   */
  async isApprovedVolunteer(
    campaignId: string,
    volunteerId: string,
  ): Promise<boolean> {
    return campaignJoiningRequestRepository.isVolunteerApproved(
      campaignId,
      volunteerId,
    );
  }

  /**
   * List approved volunteers for a campaign (managers only), with filters and pagination.
   */
  async getApprovedVolunteersForManager(
    campaignId: string,
    // managerId: string,
    query: GetApprovedVolunteersQuery,
  ): Promise<{
    volunteers: JoinRequestResponse[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    // const isManager = await campaignManagerRepository.isManager(
    //     campaignId,
    //     managerId,
    // );
    // if (!isManager) {
    //     throw new Error("Only campaign managers can view approved volunteers");
    // }

    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const sortBy = query.sortBy ?? "createdAt";
    const sortOrder = query.sortOrder ?? "desc";
    const skip = (page - 1) * limit;

    const { rows, total } =
      await campaignJoiningRequestRepository.getApprovedVolunteersPaginated(
        campaignId,
        { volunteerId: query.volunteerId },
        { skip, take: limit, sortBy, sortOrder },
      );

    const volunteerIds = [
      ...new Set(
        rows
          .map((r) => r.volunteerId)
          .filter((id): id is string => id != null && id.length > 0),
      ),
    ];
    const [profileMap, checkedInAtByUserId] = await Promise.all([
      fetchOrganizationOwnersByUserIds(volunteerIds),
      campaignAttendanceRepository.findCheckedInAtByCampaignAndUserIds(
        campaignId,
        volunteerIds,
      ),
    ]);

    return {
      volunteers: rows.map((r) => {
        const base = this.toResponse(r, profileMap);
        const vid = r.volunteerId;
        const checkedInAt =
          vid != null && vid.length > 0
            ? checkedInAtByUserId.get(vid) ?? null
            : null;
        return { ...base, checkedInAt };
      }),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  private volunteerFromMap(
    profileMap: ReadonlyMap<string, OrganizationOwnerResponse>,
    volunteerId: string | null,
  ): OrganizationOwnerResponse {
    if (!volunteerId) {
      return { id: "", name: "", avatar: null, bio: null };
    }
    return (
      getUserProfile(profileMap, volunteerId) ??
      this.volunteerFallback(volunteerId)
    );
  }

  private volunteerFallback(userId: string): OrganizationOwnerResponse {
    return { id: userId, name: "", avatar: null, bio: null };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toResponse(
    r: any,
    profileMap: ReadonlyMap<string, OrganizationOwnerResponse>,
  ): JoinRequestResponse {
    return {
      id: r.id,
      campaignId: r.campaignId,
      volunteerId: r.volunteerId,
      volunteer: this.volunteerFromMap(profileMap, r.volunteerId),
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toDetailResponse(
    r: any,
    profileMap: ReadonlyMap<string, OrganizationOwnerResponse>,
  ): JoinRequestDetailResponse {
    return {
      ...this.toResponse(r, profileMap),
      campaign: r.campaign
        ? {
            id: r.campaign.id,
            title: r.campaign.title,
            status: r.campaign.status,
            difficulty: r.campaign.difficulty,
          }
        : undefined,
    };
  }
}

export const campaignJoiningRequestService =
  new CampaignJoiningRequestService();
