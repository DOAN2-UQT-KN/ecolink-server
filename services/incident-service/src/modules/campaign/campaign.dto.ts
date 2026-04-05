import { GlobalStatus } from "../../constants/status.enum";

export interface CreateCampaignRequest {
  title: string;
  description?: string;
  reportIds?: string[];
}

export interface UpdateCampaignRequest {
  title?: string;
  description?: string;
  status?: GlobalStatus;
  reportIds?: string[];
  managerIds?: string[];
}

export interface CampaignResponse {
  id: string;
  title: string;
  description: string | null;
  status: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  reportIds: string[];
  managerIds: string[];
}

export interface AddCampaignManagersRequest {
  userIds: string[];
}

export interface CampaignManagerAssignmentResponse {
  campaignId: string;
  userId: string;
  assignedBy: string | null;
  assignedAt: Date;
}

export interface CreateJoinRequestBody {
  campaignId: string;
}

/** Query params for GET /campaigns/volunteers/join-requests (managers). */
export interface GetJoinRequestsQuery {
  campaignId: string;
  /** Join request status (e.g. pending / approved / rejected). */
  status?: number;
  volunteerId?: string;
  page?: number;
  limit?: number;
  sortBy?: "createdAt" | "updatedAt";
  sortOrder?: "asc" | "desc";
}

export interface PaginatedJoinRequestsEnvelopeData {
  joinRequests: object[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ProcessJoinRequestBody {
  requestId: string;
  approved: boolean;
}

export interface CancelJoinRequestBody {
  requestId: string;
}

/** Query for GET /campaigns/volunteers/approved (managers only). */
export interface GetApprovedVolunteersQuery {
  campaignId: string;
  volunteerId?: string;
  page?: number;
  limit?: number;
  sortBy?: "createdAt" | "updatedAt";
  sortOrder?: "asc" | "desc";
}

/** Query for GET /campaigns/volunteers/join-requests/my. */
export interface MyJoinRequestsQuery {
  campaignId?: string;
  status?: number;
  page?: number;
  limit?: number;
  sortBy?: "createdAt" | "updatedAt";
  sortOrder?: "asc" | "desc";
}

/** Query for GET /campaigns/:id/managers. */
export interface CampaignManagersListQuery {
  userId?: string;
  page?: number;
  limit?: number;
  sortBy?: "assignedAt" | "userId" | "createdAt";
  sortOrder?: "asc" | "desc";
}

export interface PaginatedVolunteersEnvelopeData {
  volunteers: object[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface PaginatedManagersEnvelopeData {
  managers: object[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface AssignVolunteerBody {
  volunteerId: string;
}

export interface TaskStatusUpdateBody {
  status: number;
}

export interface CreateCampaignTaskBody {
  title: string;
  description?: string;
  scheduledTime?: string;
}

export interface UpdateCampaignTaskBody {
  title?: string;
  description?: string;
  status?: number;
  scheduledTime?: string;
}

export interface RemoveCampaignManagerBody {
  userId: string;
}

export interface CampaignOneEnvelopeData {
  campaign: CampaignResponse;
}

/** Query params for GET /campaigns (list with filters and pagination). */
export interface CampaignListQuery {
  search?: string;
  status?: number;
  createdBy?: string;
  /** Campaigns where this user is an active manager. */
  managerId?: string;
  page?: number;
  limit?: number;
  sortBy?: "createdAt" | "updatedAt" | "title";
  sortOrder?: "asc" | "desc";
}

export interface CampaignsListEnvelopeData {
  campaigns: CampaignResponse[];
}

export interface PaginatedCampaignsEnvelopeData {
  campaigns: CampaignResponse[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface JoinRequestOneEnvelopeData {
  joinRequest: object;
}

export interface JoinRequestsListEnvelopeData {
  joinRequests: object[];
}

export interface VolunteersListEnvelopeData {
  volunteers: object[];
}

export interface ManagersListEnvelopeData {
  managers: object[];
}

export interface TaskOneEnvelopeData {
  task: object;
}

export interface TasksListEnvelopeData {
  tasks: object[];
}

export interface TaskAssignmentEnvelopeData {
  assignment: object;
}
