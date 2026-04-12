import {
  GlobalStatus,
  JoinRequestStatus,
} from "../../constants/status.enum";
import {
  HttpError,
  HTTP_STATUS,
} from "../../constants/http-status";
import prisma from "../../config/prisma.client";
import type {
  CreateOrganizationBody,
  GetOrganizationJoinRequestsQuery,
  MyOrganizationJoinRequestsQuery,
  MyOrganizationsListQuery,
  OrganizationJoinRequestDetailResponse,
  OrganizationJoinRequestResponse,
  OrganizationListQuery,
  OrganizationMemberResponse,
  OrganizationMembersListQuery,
  OrganizationResponse,
  UpdateOrganizationBody,
} from "./organization.dto";
import { issueOrganizationContactEmailToken } from "./identity-organization-contact-email.client";
import { enqueueOrganizationContactVerificationEmail } from "./organization-contact-email-notify.client";
import { buildVerifyContactEmailRequestUrl } from "./organization-contact-email-urls";
import { organizationJoiningRequestRepository } from "./organization_joining_request.repository";
import { organizationMemberRepository } from "./organization_member.repository";
import { organizationRepository } from "./organization.repository";

export class OrganizationService {
  private toOrganizationResponse(row: {
    id: string;
    name: string;
    description: string | null;
    logoUrl: string;
    backgroundUrl: string | null;
    contactEmail: string | null;
    isEmailVerified: boolean;
    status: number;
    ownerId: string;
    createdAt: Date;
    updatedAt: Date;
  }): OrganizationResponse {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      logoUrl: row.logoUrl,
      backgroundUrl: row.backgroundUrl,
      contactEmail: row.contactEmail,
      isEmailVerified: row.isEmailVerified,
      status: row.status,
      ownerId: row.ownerId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toJoinRequestResponse(row: {
    id: string;
    organizationId: string;
    requesterId: string;
    status: number;
    createdAt: Date;
    updatedAt: Date;
  }): OrganizationJoinRequestResponse {
    return {
      id: row.id,
      organizationId: row.organizationId,
      requesterId: row.requesterId,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toJoinRequestDetailResponse(r: any): OrganizationJoinRequestDetailResponse {
    const base = this.toJoinRequestResponse(r);
    const org = r.organization;
    return {
      ...base,
      organization:
        org && !org.deletedAt
          ? {
              id: org.id,
              name: org.name,
              ownerId: org.ownerId,
            }
          : undefined,
    };
  }

  async createOrganization(
    ownerId: string,
    body: CreateOrganizationBody,
  ): Promise<OrganizationResponse> {
    const created = await organizationRepository.create({
      name: body.name.trim(),
      description: body.description?.trim() || null,
      logoUrl: body.logoUrl.trim(),
      backgroundUrl: body.backgroundUrl?.trim() || null,
      contactEmail: body.contactEmail.trim().toLowerCase(),
      ownerId,
      createdBy: ownerId,
    });

    if (created.contactEmail) {
      void this.queueOrganizationContactVerificationEmail(
        created.id,
        created.name,
        created.contactEmail,
        ownerId,
      ).catch((err) => {
        console.error(
          "[OrganizationService] Failed to queue contact verification email:",
          err,
        );
      });
    }

    return this.toOrganizationResponse(created);
  }

  private async queueOrganizationContactVerificationEmail(
    organizationId: string,
    organizationName: string,
    contactEmail: string,
    ownerUserId: string,
  ): Promise<void> {
    const token = await issueOrganizationContactEmailToken({
      organizationId,
      contactEmail,
      ownerUserId,
    });
    const verifyUrl = buildVerifyContactEmailRequestUrl(token);
    await enqueueOrganizationContactVerificationEmail({
      toEmail: contactEmail,
      organizationName,
      verifyUrl,
    });
  }

  /**
   * Confirms `contactEmail` after identity-service has validated and consumed the opaque token.
   */
  async confirmOrganizationContactEmail(
    organizationId: string,
    email: string,
  ): Promise<void> {
    const org = await organizationRepository.findById(organizationId);
    if (!org) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Organization not found"),
      );
    }
    const normalized = org.contactEmail?.toLowerCase() ?? "";
    if (!normalized || normalized !== email.toLowerCase()) {
      throw new HttpError(
        HTTP_STATUS.BAD_REQUEST.withMessage("Contact email does not match"),
      );
    }
    if (org.isEmailVerified) {
      return;
    }
    await organizationRepository.update(organizationId, {
      isEmailVerified: true,
      updatedBy: org.ownerId,
    });
  }

  /** Admin-only at controller: approve organization (`status` → active). */
  async adminVerifyOrganization(
    organizationId: string,
    adminUserId: string,
  ): Promise<OrganizationResponse> {
    const existing = await organizationRepository.findById(organizationId);
    if (!existing) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Organization not found"),
      );
    }

    if (existing.status === GlobalStatus._STATUS_ACTIVE) {
      return this.toOrganizationResponse(existing);
    }

    const updated = await organizationRepository.update(organizationId, {
      status: GlobalStatus._STATUS_ACTIVE,
      updatedBy: adminUserId,
    });
    return this.toOrganizationResponse(updated);
  }

  /** Owner-only: partial update; changing `contactEmail` resets verification and queues a new email. */
  async updateOrganization(
    organizationId: string,
    ownerId: string,
    body: UpdateOrganizationBody,
  ): Promise<OrganizationResponse> {
    const org = await organizationRepository.findById(organizationId);
    if (!org) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Organization not found"),
      );
    }
    if (org.ownerId !== ownerId) {
      throw new HttpError(
        HTTP_STATUS.FORBIDDEN.withMessage(
          "Only the organization owner can update this organization",
        ),
      );
    }

    const prevEmailNorm = org.contactEmail?.toLowerCase().trim() ?? "";
    const patch: Parameters<typeof organizationRepository.update>[1] = {
      updatedBy: ownerId,
    };

    if (body.name !== undefined) {
      patch.name = body.name.trim();
    }
    if (body.description !== undefined) {
      patch.description = body.description?.trim() || null;
    }
    if (body.logoUrl !== undefined) {
      patch.logoUrl = body.logoUrl.trim();
    }
    if (body.backgroundUrl !== undefined) {
      patch.backgroundUrl =
        body.backgroundUrl === null
          ? null
          : body.backgroundUrl.trim() || null;
    }

    let contactEmailChanged = false;
    if (body.contactEmail !== undefined) {
      const next = body.contactEmail.trim().toLowerCase();
      patch.contactEmail = next;
      if (next !== prevEmailNorm) {
        contactEmailChanged = true;
        patch.isEmailVerified = false;
      }
    }

    const updated = await organizationRepository.update(organizationId, patch);

    if (contactEmailChanged && updated.contactEmail) {
      void this.queueOrganizationContactVerificationEmail(
        updated.id,
        updated.name,
        updated.contactEmail,
        ownerId,
      ).catch((err) => {
        console.error(
          "[OrganizationService] Failed to queue contact verification email after update:",
          err,
        );
      });
    }

    return this.toOrganizationResponse(updated);
  }

  /** Owner-only: resend contact verification when email is not yet verified. */
  async resendOrganizationContactVerificationEmail(
    organizationId: string,
    ownerId: string,
  ): Promise<OrganizationResponse> {
    const org = await organizationRepository.findById(organizationId);
    if (!org) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Organization not found"),
      );
    }
    if (org.ownerId !== ownerId) {
      throw new HttpError(
        HTTP_STATUS.FORBIDDEN.withMessage(
          "Only the organization owner can resend the verification email",
        ),
      );
    }
    const email = org.contactEmail?.trim();
    if (!email) {
      throw new HttpError(
        HTTP_STATUS.BAD_REQUEST.withMessage(
          "Organization has no contact email to verify",
        ),
      );
    }
    if (org.isEmailVerified) {
      throw new HttpError(
        HTTP_STATUS.BAD_REQUEST.withMessage(
          "Contact email is already verified",
        ),
      );
    }

    try {
      await this.queueOrganizationContactVerificationEmail(
        org.id,
        org.name,
        email.toLowerCase(),
        ownerId,
      );
    } catch (err) {
      console.error(
        "[OrganizationService] Resend contact verification email failed:",
        err,
      );
      throw new HttpError(
        HTTP_STATUS.BAD_GATEWAY.withMessage(
          "Failed to send verification email; try again later",
        ),
      );
    }

    return this.toOrganizationResponse(org);
  }

  /**
   * Maps latest join-request row to API `request_status` (same numeric `JoinRequestStatus` /
   * `GlobalStatus` as stored on the request). Omitted when there is no row, the latest is
   * rejected, or the status is otherwise not exposed.
   */
  private joinRequestStatusForOrganizationDetail(
    joinRequestStatus: number | undefined,
  ): number | undefined {
    if (joinRequestStatus === undefined) return undefined;
    if (joinRequestStatus === JoinRequestStatus._STATUS_REJECTED) {
      return undefined;
    }
    if (
      joinRequestStatus === JoinRequestStatus._STATUS_PENDING ||
      joinRequestStatus === JoinRequestStatus._STATUS_APPROVED
    ) {
      return joinRequestStatus;
    }
    return undefined;
  }

  async getById(
    organizationId: string,
    viewerUserId?: string,
  ): Promise<OrganizationResponse | null> {
    const row = await organizationRepository.findById(organizationId);
    if (!row) return null;
    const organization = this.toOrganizationResponse(row);
    if (!viewerUserId) {
      return organization;
    }
    const latestJoin =
      await organizationJoiningRequestRepository.findLatestByOrganizationAndRequester(
        organizationId,
        viewerUserId,
      );
    const requestStatus = this.joinRequestStatusForOrganizationDetail(
      latestJoin?.status,
    );
    return requestStatus !== undefined
      ? { ...organization, requestStatus }
      : organization;
  }

  private async organizationIdsForJoinRequestStatusFilter(
    viewerUserId: string,
    requestStatus: number | undefined,
  ): Promise<string[] | undefined> {
    if (requestStatus === undefined) {
      return undefined;
    }
    return organizationJoiningRequestRepository.findOrganizationIdsWhereLatestJoinRequestStatusEquals(
      viewerUserId,
      requestStatus,
    );
  }

  private async withOrganizationListRequestStatus(
    organizations: OrganizationResponse[],
    viewerUserId: string,
  ): Promise<OrganizationResponse[]> {
    if (organizations.length === 0) {
      return organizations;
    }
    const statusByOrgId =
      await organizationJoiningRequestRepository.findLatestStatusByOrganizationForRequester(
        viewerUserId,
        organizations.map((o) => o.id),
      );
    return organizations.map((org) => {
      const requestStatus = this.joinRequestStatusForOrganizationDetail(
        statusByOrgId.get(org.id),
      );
      return requestStatus !== undefined ? { ...org, requestStatus } : org;
    });
  }

  async listMyOrganizations(
    userId: string,
    query: MyOrganizationsListQuery,
  ): Promise<{
    organizations: OrganizationResponse[];
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

    const joinRequestOrgIds = await this.organizationIdsForJoinRequestStatusFilter(
      userId,
      query.requestStatus,
    );
    if (joinRequestOrgIds !== undefined && joinRequestOrgIds.length === 0) {
      return {
        organizations: [],
        total: 0,
        page,
        limit,
        totalPages: 0,
      };
    }

    const { rows, total } =
      await organizationRepository.findLinkedToUserPaginated(
        userId,
        {
          search: query.search,
          status: query.status,
          isEmailVerified: query.isEmailVerified,
          organizationIdIn: joinRequestOrgIds,
        },
        { skip, take: limit, sortBy, sortOrder },
      );

    const organizations = rows.map((r) => this.toOrganizationResponse(r));
    return {
      organizations: await this.withOrganizationListRequestStatus(
        organizations,
        userId,
      ),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 0,
    };
  }

  async listOrganizations(
    query: OrganizationListQuery,
    viewerUserId: string,
  ): Promise<{
    organizations: OrganizationResponse[];
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

    const joinRequestOrgIds = await this.organizationIdsForJoinRequestStatusFilter(
      viewerUserId,
      query.requestStatus,
    );
    if (joinRequestOrgIds !== undefined && joinRequestOrgIds.length === 0) {
      return {
        organizations: [],
        total: 0,
        page,
        limit,
        totalPages: 0,
      };
    }

    const { rows, total } = await organizationRepository.findManyPaginated(
      {
        search: query.search,
        status: query.status,
        isEmailVerified: query.isEmailVerified,
        organizationIdIn: joinRequestOrgIds,
      },
      { skip, take: limit, sortBy, sortOrder },
    );

    const organizations = rows.map((r) => this.toOrganizationResponse(r));
    return {
      organizations: await this.withOrganizationListRequestStatus(
        organizations,
        viewerUserId,
      ),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 0,
    };
  }

  async createJoinRequest(
    organizationId: string,
    requesterId: string,
  ): Promise<OrganizationJoinRequestResponse> {
    const org = await organizationRepository.findById(organizationId);
    if (!org) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Organization not found"),
      );
    }

    if (org.ownerId === requesterId) {
      throw new HttpError(
        HTTP_STATUS.BAD_REQUEST.withMessage(
          "Organization owner cannot request to join",
        ),
      );
    }

    const isMember = await organizationMemberRepository.isActiveMember(
      organizationId,
      requesterId,
    );
    if (isMember) {
      throw new HttpError(
        HTTP_STATUS.CONFLICT.withMessage("Already a member of this organization"),
      );
    }

    const pending =
      await organizationJoiningRequestRepository.findPending(
        organizationId,
        requesterId,
      );
    if (pending) {
      throw new HttpError(HTTP_STATUS.JOIN_REQUEST_ALREADY_EXISTS);
    }

    const row = await organizationJoiningRequestRepository.create({
      organizationId,
      requesterId,
    });
    return this.toJoinRequestResponse(row);
  }

  async listJoinRequestsForOwner(
    organizationId: string,
    ownerId: string,
    query: GetOrganizationJoinRequestsQuery,
  ): Promise<{
    joinRequests: OrganizationJoinRequestResponse[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const org = await organizationRepository.findById(organizationId);
    if (!org) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Organization not found"),
      );
    }
    if (org.ownerId !== ownerId) {
      throw new HttpError(
        HTTP_STATUS.FORBIDDEN.withMessage(
          "Only the organization owner can view join requests",
        ),
      );
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const sortBy = query.sortBy ?? "createdAt";
    const sortOrder = query.sortOrder ?? "desc";
    const skip = (page - 1) * limit;

    const { rows, total } =
      await organizationJoiningRequestRepository.findByOrganizationPaginated(
        organizationId,
        {
          status: query.status,
          requesterId: query.requesterId,
        },
        { skip, take: limit, sortBy, sortOrder },
      );

    return {
      joinRequests: rows.map((r) => this.toJoinRequestResponse(r)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 0,
    };
  }

  async getMyJoinRequests(
    requesterId: string,
    query: MyOrganizationJoinRequestsQuery,
  ): Promise<{
    joinRequests: OrganizationJoinRequestDetailResponse[];
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
      await organizationJoiningRequestRepository.findByRequesterPaginated(
        requesterId,
        {
          organizationId: query.organizationId,
          status: query.status,
        },
        { skip, take: limit, sortBy, sortOrder },
      );

    return {
      joinRequests: rows.map((r) => this.toJoinRequestDetailResponse(r)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 0,
    };
  }

  async processJoinRequest(
    requestId: string,
    ownerId: string,
    status: GlobalStatus._STATUS_APPROVED | GlobalStatus._STATUS_REJECTED,
  ): Promise<OrganizationJoinRequestResponse> {
    const request =
      await organizationJoiningRequestRepository.findByIdWithOrganization(
        requestId,
      );
    if (!request || !request.organization) {
      throw new HttpError(HTTP_STATUS.JOIN_REQUEST_NOT_FOUND);
    }

    if (request.organization.deletedAt != null) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Organization not found"),
      );
    }

    if (request.organization.ownerId !== ownerId) {
      throw new HttpError(
        HTTP_STATUS.FORBIDDEN.withMessage(
          "Only the organization owner can process join requests",
        ),
      );
    }

    if (request.status !== JoinRequestStatus._STATUS_PENDING) {
      throw new HttpError(HTTP_STATUS.JOIN_REQUEST_ALREADY_PROCESSED);
    }

    if (status === JoinRequestStatus._STATUS_APPROVED) {
      await prisma.$transaction([
        prisma.organizationJoiningRequest.update({
          where: { id: requestId },
          data: { status },
        }),
        prisma.organizationMember.upsert({
          where: {
            organizationId_userId: {
              organizationId: request.organizationId,
              userId: request.requesterId,
            },
          },
          create: {
            organizationId: request.organizationId,
            userId: request.requesterId,
            createdBy: ownerId,
          },
          update: {
            deletedAt: null,
            updatedAt: new Date(),
            updatedBy: ownerId,
          },
        }),
      ]);
    } else {
      await organizationJoiningRequestRepository.updateStatus(
        requestId,
        status,
      );
    }

    const updated =
      await organizationJoiningRequestRepository.findById(requestId);
    if (!updated) {
      throw new HttpError(HTTP_STATUS.JOIN_REQUEST_NOT_FOUND);
    }
    return this.toJoinRequestResponse(updated);
  }

  async cancelJoinRequest(
    requestId: string,
    requesterId: string,
  ): Promise<void> {
    const request =
      await organizationJoiningRequestRepository.findById(requestId);
    if (!request) {
      throw new HttpError(HTTP_STATUS.JOIN_REQUEST_NOT_FOUND);
    }

    if (request.requesterId !== requesterId) {
      throw new HttpError(
        HTTP_STATUS.FORBIDDEN.withMessage(
          "Cannot cancel another user's join request",
        ),
      );
    }

    if (request.status !== JoinRequestStatus._STATUS_PENDING) {
      throw new HttpError(
        HTTP_STATUS.BAD_REQUEST.withMessage("Can only cancel pending requests"),
      );
    }

    await organizationJoiningRequestRepository.softDelete(requestId);
  }

  async listMembersForOwner(
    organizationId: string,
    ownerId: string,
    query: OrganizationMembersListQuery,
  ): Promise<{
    members: OrganizationMemberResponse[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const org = await organizationRepository.findById(organizationId);
    if (!org) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Organization not found"),
      );
    }
    if (org.ownerId !== ownerId) {
      throw new HttpError(
        HTTP_STATUS.FORBIDDEN.withMessage(
          "Only the organization owner can list members",
        ),
      );
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const sortBy = query.sortBy ?? "createdAt";
    const sortOrder = query.sortOrder ?? "desc";
    const skip = (page - 1) * limit;

    const { rows, total } =
      await organizationMemberRepository.findByOrganizationPaginated(
        organizationId,
        { userId: query.userId },
        { skip, take: limit, sortBy, sortOrder },
      );

    const members: OrganizationMemberResponse[] = rows.map((r) => ({
      organizationId: r.organizationId,
      userId: r.userId,
      createdAt: r.createdAt,
    }));

    return {
      members,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 0,
    };
  }

  async leaveOrganization(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const org = await organizationRepository.findById(organizationId);
    if (!org) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Organization not found"),
      );
    }
    if (org.ownerId === userId) {
      throw new HttpError(
        HTTP_STATUS.BAD_REQUEST.withMessage(
          "Organization owners cannot leave; transfer ownership or delete the organization",
        ),
      );
    }
    const left = await organizationMemberRepository.softDeleteMembership(
      organizationId,
      userId,
    );
    if (!left) {
      throw new HttpError(
        HTTP_STATUS.BAD_REQUEST.withMessage(
          "You are not a member of this organization",
        ),
      );
    }
  }
}

export const organizationService = new OrganizationService();
