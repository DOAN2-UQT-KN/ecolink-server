import type { KycStatus, OrgType, TrustTier } from "@da2/constants";

/**
 * Body for POST /api/v1/organizations (internal only; JSON keys may be snake_case and the
 * middleware normalizes them to camelCase).
 */
export interface CreateOrganizationBody {
  /** Internal callers carry no JWT, so the owner is named in the body. */
  ownerId: string;
  name: string;
  description?: string;
  descriptionVi?: string;
  descriptionEn?: string;
  /** Required; clients send `logo_url`. */
  logoUrl: string;
  /** Optional; clients send `background_url`. */
  backgroundUrl?: string;
  /** Required; clients send `contact_email`. */
  contactEmail: string;
}

/**
 * Body for PUT /api/v1/organizations/:id/verify (admin).
 * `GlobalStatus._STATUS_ACTIVE` (1) verifies; `_STATUS_INACTIVE` (2) bans.
 */
export interface AdminVerifyOrganizationBody {
  /** `GlobalStatus`: use `_STATUS_ACTIVE` (1) to verify, `_STATUS_INACTIVE` (2) to ban. */
  status: number;
  /**
   * Required when `status` is `_STATUS_INACTIVE` (ban).
   * Optional when verifying; omit, `null`, or empty to clear any previous reason.
   */
  rejectReason?: string | null;
}

/** Public owner profile on organization responses (from identity-service; no email). */
export interface OrganizationOwnerResponse {
  id: string;
  name: string;
  avatar: string | null;
  bio: string | null;
}

/** Body for PUT /api/v1/organizations/:id (owner). At least one field required. */
export interface UpdateOrganizationBody {
  name?: string;
  description?: string;
  descriptionVi?: string;
  descriptionEn?: string;
  logoUrl?: string;
  /** Omit to leave unchanged; send `null` to clear. */
  backgroundUrl?: string | null;
  contactEmail?: string;
}

export interface OrganizationResponse {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  descriptionVi?: string | null;
  descriptionEn?: string | null;
  logoUrl: string;
  backgroundUrl: string | null;
  contactEmail: string | null;
  isEmailVerified: boolean;
  /** `GlobalStatus` numeric value (e.g. in-review until admin approves via verify endpoint). */
  status: number;
  /** Admin ban reason; `null` when the organization has not been banned (or reason was cleared). */
  rejectReason: string | null;
  /** Kind of legal entity, confirmed by an admin on approval; `null` for legacy rows. */
  orgType: OrgType | null;
  /** Verdict on the legal paperwork. Independent of `trustTier`. */
  kycStatus: KycStatus;
  /** Blue Tick level; the client shows the tick only for `VERIFIED` and not `tickSuspended`. */
  trustTier: TrustTier;
  /** True while a violation is being handled: the tick is hidden. */
  tickSuspended: boolean;
  verifiedAt: Date | null;
  /** Lane B ticks expire and must be re-assessed; `null` for lane A. */
  verificationExpiresAt: Date | null;
  /**
   * The dedicated ORG login. `null` between the two halves of provisioning (the organization
   * row is written before the account exists), so consumers must tolerate it.
   */
  ownerId: string | null;
  /** Owner profile from identity-service; `null` while `ownerId` is null. */
  owner: OrganizationOwnerResponse | null;
  /**
   * Active member count (owner is not stored in `organization_members` and is not included).
   * Included on GET /organizations and GET /organizations/my.
   */
  members?: number;
  createdAt: Date;
  updatedAt: Date;
  /**
   * For the current user, when their latest non-deleted org join request is pending
   * (`JoinRequestStatus._STATUS_PENDING`) or approved (`JoinRequestStatus._STATUS_APPROVED`).
   * Included on GET /organizations/:id, GET /organizations, GET /organizations/by-slug/:slug,
   * and GET /organizations/my.
   * Omitted if there is no request or the latest is rejected.
   */
  requestStatus?: number;
  /**
   * Latest pending join-request id for the current user on this organization.
   * Included with `requestStatus` when that status is pending, so the client can cancel.
   */
  joinRequestId?: string;
  /**
   * For the current user: true when they are an active member of this organization.
   * (Owners are exposed separately via `ownerId`.)
   * Included on GET /organizations/:id, GET /organizations, and GET /organizations/my.
   */
  isMember?: boolean;
}

export interface OrganizationJoinRequestResponse {
  id: string;
  organizationId: string;
  requesterId: string;
  /** Requester profile from identity-service (same shape as organization `owner`). */
  requester: OrganizationOwnerResponse;
  status: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationJoinRequestDetailResponse
  extends OrganizationJoinRequestResponse {
  organization?: {
    id: string;
    name: string;
    ownerId: string | null;
  };
}

export interface OrganizationMemberResponse {
  organizationId: string;
  userId: string;
  /** Member profile from identity-service (same shape as organization `owner`). */
  user: OrganizationOwnerResponse;
  createdAt: Date;
}

/** Query for GET /api/v1/organizations/verify-contact-email */
export interface OrganizationVerifyContactEmailQuery {
  token: string;
}

/** Query for GET /api/v1/organizations (discovery). */
export interface OrganizationListQuery {
  search?: string;
  /**
   * Organization lifecycle `GlobalStatus`: org `status` must be one of these values.
   * Query as repeated `status=1&status=9` and/or comma-separated `status=1,9`.
   */
  status?: number[];
  /** When set, only organizations with this contact-email verification flag. */
  isEmailVerified?: boolean;
  /**
   * Filter: only organizations where the viewer's latest join request for that org has one of
   * these statuses (`JoinRequestStatus`, e.g. 12 pending, 14 approved). Use repeated or comma-separated params.
   */
  requestStatus?: number[];
  page?: number;
  limit?: number;
  sortBy?: "createdAt" | "updatedAt" | "name";
  sortOrder?: "asc" | "desc";
}

/** Query for GET /api/v1/organizations/my (organizations I own or am a member of). */
export interface MyOrganizationsListQuery {
  search?: string;
  /**
   * Organization lifecycle `GlobalStatus`: org `status` must be one of these values.
   * Query as repeated `status=1&status=9` and/or comma-separated `status=1,9`.
   */
  status?: number[];
  /** When set, only organizations with this contact-email verification flag. */
  isEmailVerified?: boolean;
  /**
   * Filter: only organizations where the viewer's latest join request for that org has one of
   * these statuses. Use repeated or comma-separated params.
   */
  requestStatus?: number[];
  /**
   * When `true`, only organizations I own (`ownerId`). When `false`, only organizations where I am an
   * approved member but not the owner. Omit for both (owned and member-of).
   */
  isOwner?: boolean;
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
  /** Case-insensitive substring match on member display name (from identity-service). */
  search?: string;
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
