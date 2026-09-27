import { GlobalStatus } from "../../constants/status.enum";
import type { OrganizationOwnerResponse } from "../organization/organization.dto";
import type { ResourceVoteSummary } from "../vote/vote.dto";
import type { CampaignCompletionVerificationSummary } from "./campaign_completion_verification/campaign_completion_verification.dto";
import type { ReportResponse } from "../report/report.dto";

export interface CampaignOrganizationResponse {
  background_url: string | null;
  contact_email: string | null;
  logo_url: string | null;
  name: string | null;
  slug: string | null;
}

export interface CampaignManagerBasicResponse {
  id: string;
  name: string;
  avatar: string | null;
}

export interface CreateCampaignRequest {
  /** Organization that owns this campaign; caller must hold an owner role in it. */
  organizationId: string;
  title: string;
  titleVi?: string;
  titleEn?: string;
  banner?: string;
  description?: string;
  descriptionVi?: string;
  descriptionEn?: string;
  startDate?: string;
  endDate?: string;
  detailAddress?: string;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  /** 1 = easy … 4 = very hard; must exist in reward-service `difficulties` table. */
  difficulty: number;
  reportIds?: string[];
}

/**
 * Body for PUT /api/v1/campaigns/:id/verify (admin).
 * `GlobalStatus._STATUS_ACTIVE` (1) verifies; `_STATUS_INACTIVE` (2) bans.
 */
export interface AdminVerifyCampaignBody {
  /** `GlobalStatus`: use `_STATUS_ACTIVE` (1) to verify, `_STATUS_INACTIVE` (2) to ban. */
  status: number;
  /**
   * Required when `status` is `_STATUS_INACTIVE` (ban).
   * Optional when verifying; omit, `null`, or empty to clear any previous reason.
   */
  rejectReason?: string | null;
}

/** Body for PUT /api/v1/campaigns/:id/completion-review (admin). */
export interface AdminCompletionReviewBody {
  decision: "approve" | "reject";
  /** Required when `decision` is `"reject"`. */
  rejectReason?: string | null;
}

export interface UpdateCampaignRequest {
  title?: string;
  titleVi?: string;
  titleEn?: string;
  banner?: string | null;
  description?: string;
  descriptionVi?: string;
  descriptionEn?: string;
  status?: GlobalStatus;
  difficulty?: number;
  startDate?: string | null;
  endDate?: string | null;
  detailAddress?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  radiusKm?: number | null;
  reportIds?: string[];
  managerIds?: string[];
}

export interface CampaignResponse {
  id: string;
  /** Organization the campaign belongs to. */
  organizationId: string;
  Organization?: CampaignOrganizationResponse;
  /** Profile of the person who created the campaign for the organization (identity-service). */
  owner: OrganizationOwnerResponse | null;
  title: string;
  titleVi?: string | null;
  titleEn?: string | null;
  banner: string | null;
  description: string | null;
  descriptionVi?: string | null;
  descriptionEn?: string | null;
  status: number;
  /** Admin ban reason; null when verified or never banned. */
  rejectReason: string | null;
  startDate: Date | null;
  endDate: Date | null;
  detailAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  radiusKm: number | null;
  difficulty: number;
  /** Green points for this difficulty tier (reward rules). */
  greenPoints: number;
  /** Count of approved campaign join requests (volunteers). */
  currentMembers: number;
  /** Volunteer cap for this difficulty tier from reward-service; null means no limit. */
  maxMembers: number | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  reports: ReportResponse[];
  managers: CampaignManagerBasicResponse[];
  votes: ResourceVoteSummary;
  /** Community clean / not-clean verification after mark-done (separate from votes). */
  completionVerification: CampaignCompletionVerificationSummary;
  /**
   * Whether the current user saved this campaign. Null when the viewer is unknown (unauthenticated).
   */
  saved: boolean | null;
  /**
   * For the current user when their latest non-deleted campaign join request is pending
   * (`JoinRequestStatus._STATUS_PENDING`) or approved (`JoinRequestStatus._STATUS_APPROVED`).
   * Present on GET /campaigns and GET /campaigns/:id; omitted if there is no request or the latest is rejected.
   */
  requestStatus?: number;
  /** True when the viewer is the campaign creator or an assigned campaign manager. */
  canManageCampaign?: boolean;
}

export interface AddCampaignManagersRequest {
  userIds: string[];
}

export interface CampaignManagerAssignmentResponse {
  campaignId: string;
  userId: string;
  /** Display name from identity-service; empty string when not found. */
  name: string;
  /** Avatar URL from identity-service; null when not found. */
  avatar: string | null;
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

/**
 * Join request with volunteer profile from identity-service (name, avatar, bio),
 * same shape as organization `owner` / `requester` on org join requests.
 */
export interface CampaignJoinRequestResponse {
  id: string;
  campaignId: string | null;
  volunteerId: string | null;
  volunteer: OrganizationOwnerResponse;
  status: number;
  createdAt: Date;
  updatedAt: Date;
  /** Present on approved-volunteer list when in-person check-in was recorded. */
  checkedInAt?: Date | null;
}

export interface CampaignJoinRequestDetailResponse
  extends CampaignJoinRequestResponse {
  campaign?: {
    id: string;
    title: string;
    status: number;
    difficulty: number;
  };
}

export interface PaginatedJoinRequestsEnvelopeData {
  joinRequests: CampaignJoinRequestResponse[];
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
  volunteers: CampaignJoinRequestResponse[];
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
  priority?: 1 | 2 | 3;
  scheduledDate?: string;
  scheduledTime?: string;
}

export interface UpdateCampaignTaskBody {
  title?: string;
  description?: string;
  status?: number;
  priority?: 1 | 2 | 3;
  scheduledDate?: string;
  scheduledTime?: string;
  result?: {
    description?: string;
    file?: string[];
  };
}

export interface RemoveCampaignManagerBody {
  userId: string;
}

export interface CampaignOneEnvelopeData {
  campaign: CampaignResponse;
}

/** Query params for GET /campaigns (list with filters and pagination). */
export interface CampaignListQuery {
  /** Response locale for localized title/description (`en` | `vi`). */
  lang?: "en" | "vi";
  search?: string;
  status?: number;
  statuses?: number[];
  createdBy?: string;
  /** Campaigns where this user is an active manager. */
  managerId?: string;
  page?: number;
  limit?: number;
  sortBy?: "createdAt" | "updatedAt" | "title";
  sortOrder?: "asc" | "desc";
  organizationId?: string;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  difficulty?: number;
  greenPointsFrom?: number;
  greenPointsTo?: number;
  isOwner?: boolean;
}

/** Query for GET /campaigns/admin/awaiting-multi-submission-review. */
export interface CampaignMultiSubmissionReviewListQuery {
  page?: number;
  limit?: number;
  sortBy?: "createdAt" | "updatedAt" | "title";
  sortOrder?: "asc" | "desc";
}

export interface CampaignWithAwaitingSubmissionCount extends CampaignResponse {
  awaitingSubmissionCount: number;
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
