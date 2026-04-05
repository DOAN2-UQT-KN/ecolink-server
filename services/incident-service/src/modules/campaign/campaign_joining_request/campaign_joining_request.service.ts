import { campaignJoiningRequestRepository } from "./campaign_joining_request.repository";
import { campaignRepository } from "../campaign.repository";
import { campaignManagerRepository } from "../campaign_manager/campaign_manager.repository";
import { GlobalStatus, JoinRequestStatus } from "../../../constants/status.enum";
import type {
    GetApprovedVolunteersQuery,
    GetJoinRequestsQuery,
    MyJoinRequestsQuery,
} from "../campaign.dto";

export interface CreateJoinRequestRequest {
    campaignId: string;
}

export interface UpdateJoinRequestRequest {
    status: GlobalStatus._STATUS_APPROVED | GlobalStatus._STATUS_REJECTED;
}

export interface JoinRequestResponse {
    id: string;
    campaignId: string | null;
    volunteerId: string | null;
    status: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface JoinRequestDetailResponse extends JoinRequestResponse {
    campaign?: {
        id: string;
        title: string;
        status: number;
    };
}

export class CampaignJoiningRequestService {
    constructor() { }

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

        return this.toResponse(request);
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
        return this.toDetailResponse(request);
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

        return {
            joinRequests: rows.map((r) => this.toResponse(r)),
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

        return {
            joinRequests: rows.map((r) => this.toDetailResponse(r)),
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        };
    }

    /**
     * Approve or reject a join request.
     * Only campaign managers can process join requests.
     */
    async processJoinRequest(
        requestId: string,
        managerId: string,
        status: GlobalStatus._STATUS_APPROVED | GlobalStatus._STATUS_REJECTED,
    ): Promise<JoinRequestResponse> {
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
            throw new Error("Only campaign managers can approve/reject join requests");
        }

        if (request.status !== JoinRequestStatus._STATUS_PENDING) {
            throw new Error("Join request already processed");
        }

        const updated = await campaignJoiningRequestRepository.updateStatus(
            requestId,
            status,
        );

        return this.toResponse(updated);
    }

    /**
     * Cancel a join request (by the volunteer who created it).
     */
    async cancelJoinRequest(
        requestId: string,
        volunteerId: string,
    ): Promise<void> {
        const request =
            await campaignJoiningRequestRepository.findById(requestId);
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
        managerId: string,
        query: GetApprovedVolunteersQuery,
    ): Promise<{
        volunteers: { volunteerId: string | null }[];
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
            throw new Error("Only campaign managers can view approved volunteers");
        }

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

        return {
            volunteers: rows.map((v) => ({ volunteerId: v.volunteerId })),
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private toResponse(r: any): JoinRequestResponse {
        return {
            id: r.id,
            campaignId: r.campaignId,
            volunteerId: r.volunteerId,
            status: r.status,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private toDetailResponse(r: any): JoinRequestDetailResponse {
        return {
            ...this.toResponse(r),
            campaign: r.campaign
                ? {
                    id: r.campaign.id,
                    title: r.campaign.title,
                    status: r.campaign.status,
                }
                : undefined,
        };
    }
}

export const campaignJoiningRequestService =
    new CampaignJoiningRequestService();
