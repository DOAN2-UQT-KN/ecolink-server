/** Body for POST /api/v1/organizations (JSON keys may be snake_case; middleware normalizes to camelCase). */
export interface CreateOrganizationBody {
  name: string;
  description?: string;
  /** Required; clients send `logo_url`. */
  logoUrl: string;
  /** Optional; clients send `background_url`. */
  backgroundUrl?: string;
  /** Required; clients send `contact_email`. */
  contactEmail: string;
}

/** Body for PUT /api/v1/organizations/:id (owner). At least one field required. */
export interface UpdateOrganizationBody {
  name?: string;
  description?: string;
  logoUrl?: string;
  /** Omit to leave unchanged; send `null` to clear. */
  backgroundUrl?: string | null;
  contactEmail?: string;
}

export interface OrganizationResponse {
  id: string;
  name: string;
  description: string | null;
  logoUrl: string;
  backgroundUrl: string | null;
  contactEmail: string | null;
  isEmailVerified: boolean;
  /** `GlobalStatus` numeric value (e.g. in-review until admin approves via verify endpoint). */
  status: number;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
  /**
   * For the current user, when their latest non-deleted org join request is pending
   * (`JoinRequestStatus._STATUS_PENDING`) or approved (`JoinRequestStatus._STATUS_APPROVED`).
   * Included on GET /organizations/:id, GET /organizations, and GET /organizations/my.
   * Omitted if there is no request or the latest is rejected.
   */
  requestStatus?: number;
}

export interface OrganizationJoinRequestResponse {
  id: string;
  organizationId: string;
  requesterId: string;
  status: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationJoinRequestDetailResponse
  extends OrganizationJoinRequestResponse {
  organization?: {
    id: string;
    name: string;
    ownerId: string;
  };
}

export interface OrganizationMemberResponse {
  organizationId: string;
  userId: string;
  createdAt: Date;
}

/** Query for GET /api/v1/organizations/verify-contact-email */
export interface OrganizationVerifyContactEmailQuery {
  token: string;
}

/** Query for GET /api/v1/organizations (discovery). */
export interface OrganizationListQuery {
  search?: string;
  /** Organization lifecycle `GlobalStatus` (exact match on `organizations.status`). */
  status?: number;
  /** When set, only organizations with this contact-email verification flag. */
  isEmailVerified?: boolean;
  /**
   * Filter: only organizations where the viewer's latest join request for that org has this
   * status (`JoinRequestStatus`, e.g. 12 pending, 14 approved, 18 rejected).
   */
  requestStatus?: number;
  page?: number;
  limit?: number;
  sortBy?: "createdAt" | "updatedAt" | "name";
  sortOrder?: "asc" | "desc";
}

/** Query for GET /api/v1/organizations/my (organizations I own or am a member of). */
export interface MyOrganizationsListQuery {
  search?: string;
  /** Organization lifecycle `GlobalStatus` (exact match on `organizations.status`). */
  status?: number;
  /** When set, only organizations with this contact-email verification flag. */
  isEmailVerified?: boolean;
  /**
   * Filter: only organizations where the viewer's latest join request for that org has this
   * status (`JoinRequestStatus`, e.g. 12 pending, 14 approved, 18 rejected).
   */
  requestStatus?: number;
  page?: number;
  limit?: number;
  sortBy?: "createdAt" | "updatedAt" | "name";
  sortOrder?: "asc" | "desc";
}

/** Query for GET /api/v1/organizations/:id/join-requests (owner). */
export interface GetOrganizationJoinRequestsQuery {
  status?: number;
  requesterId?: string;
  page?: number;
  limit?: number;
  sortBy?: "createdAt" | "updatedAt";
  sortOrder?: "asc" | "desc";
}

/** Query for GET /api/v1/organizations/join-requests/my. */
export interface MyOrganizationJoinRequestsQuery {
  organizationId?: string;
  status?: number;
  page?: number;
  limit?: number;
  sortBy?: "createdAt" | "updatedAt";
  sortOrder?: "asc" | "desc";
}

/** Query for GET /api/v1/organizations/:id/members (owner). */
export interface OrganizationMembersListQuery {
  userId?: string;
  page?: number;
  limit?: number;
  sortBy?: "createdAt" | "updatedAt";
  sortOrder?: "asc" | "desc";
}

export interface OrganizationOneEnvelopeData {
  organization: OrganizationResponse;
}

export interface PaginatedOrganizationsEnvelopeData {
  organizations: OrganizationResponse[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface OrganizationJoinRequestOneEnvelopeData {
  joinRequest: OrganizationJoinRequestResponse;
}

export interface PaginatedOrganizationJoinRequestsEnvelopeData {
  joinRequests: OrganizationJoinRequestResponse[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface PaginatedOrganizationJoinRequestsDetailEnvelopeData {
  joinRequests: OrganizationJoinRequestDetailResponse[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ProcessOrganizationJoinRequestBody {
  requestId: string;
  approved: boolean;
}

export interface CancelOrganizationJoinRequestBody {
  requestId: string;
}

export interface PaginatedOrganizationMembersEnvelopeData {
  members: OrganizationMemberResponse[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}
