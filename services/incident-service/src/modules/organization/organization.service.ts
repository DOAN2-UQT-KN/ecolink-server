import { GlobalStatus, JoinRequestStatus } from "../../constants/status.enum";
import { HttpError, HTTP_STATUS } from "../../constants/http-status";
import prisma from "../../config/prisma.client";
import { Prisma, type Organization } from "@prisma/client";
import {
  type KycStatus,
  type OrgType,
  type TrustTier,
  MembershipSource,
  OrgMemberRole,
  OrgPermission,
  canActOnMember,
  isOwnerRole,
  nextUniqueOrganizationSlug,
  slugifyOrganizationName,
} from "@da2/constants";
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
  OrganizationOwnerResponse,
  OrganizationOwnerWithRoleResponse,
  OrganizationResponse,
  UpdateOrganizationBody,
} from "./organization.dto";
import { issueOrganizationContactEmailToken } from "./identity-organization-contact-email.client";
import {
  fetchOrganizationOwnersByUserIds,
  getUserProfile,
} from "./identity-user.client";
import {
  enqueueOrganizationApprovedWebsiteNotification,
  enqueueOrganizationRejectedWebsiteNotification,
  enqueueVolunteerApprovedWebsiteNotification,
  enqueueVolunteerRejectedWebsiteNotification,
  enqueueVolunteerRequestWebsiteNotification,
} from "../campaign/notification-jobs.client";
import { enqueueOrganizationContactVerificationEmail } from "./organization-contact-email-notify.client";
import { buildVerifyContactEmailRequestUrl } from "./organization-contact-email-urls";
import { organizationJoiningRequestRepository } from "./organization_joining_request.repository";
import { organizationMemberRepository } from "./organization_member.repository";
import { organizationRepository } from "./organization.repository";
import { orgAccessService } from "./org-access.service";
import { organizationMembershipService } from "./organization-membership.service";
import { enqueueOrgMembershipChangedWebsiteNotification } from "./organization-member-notify.client";
import { backgroundJobDispatcher } from "../../queue/register";
import {
  ReportJobType,
  TranslationFieldTarget,
  TranslationResourceType,
} from "../../constants/job-type.enum";

/**
 * Best-effort enqueue of a TRANSLATE_TEXT job for an organization. Failure is
 * logged but does NOT propagate so request handlers stay fast and do not roll
 * back the primary write when SQS is unavailable.
 */
function enqueueOrganizationTranslationJob(
  resourceId: string,
  translations: TranslationFieldTarget[],
): void {
  const cleaned = translations.filter(
    (t) => t.sourceText.trim().length > 0 && (t.viField || t.enField),
  );
  if (cleaned.length === 0) {
    return;
  }
  backgroundJobDispatcher
    .enqueue(ReportJobType.TRANSLATE_TEXT, {
      resourceType: TranslationResourceType.ORGANIZATION,
      resourceId,
      translations: cleaned,
    })
    .catch((err: Error) => {
      console.error(
        "[incident-service] Failed to enqueue organization translation job:",
        err.message,
      );
    });
}

type OrganizationCore = Omit<OrganizationResponse, "owners">;

export class OrganizationService {
  private organizationCoreFromRow(row: Organization): OrganizationCore {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: null,
      descriptionVi: row.descriptionVi ?? row.description ?? null,
      descriptionEn: row.descriptionEn ?? null,
      logoUrl: row.logoUrl,
      backgroundUrl: row.backgroundUrl,
      contactEmail: row.contactEmail,
      isEmailVerified: row.isEmailVerified,
      status: row.status,
      rejectReason: row.rejectReason ?? null,
      orgType: (row.orgType as OrgType | null) ?? null,
      kycStatus: row.kycStatus as KycStatus,
      trustTier: row.trustTier as TrustTier,
      tickSuspended: row.tickSuspended,
      verifiedAt: row.verifiedAt,
      verificationExpiresAt: row.verificationExpiresAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private ownerFallback(ownerId: string): OrganizationOwnerResponse {
    return { id: ownerId, name: "", avatar: null, bio: null };
  }

  private async withOwner(
    core: OrganizationCore,
  ): Promise<OrganizationResponse> {
    const [withOwners] = await this.withOwners([core]);
    return withOwners;
  }

  /** Attaches the active owners (owner / legal representative memberships) with profiles. */
  private async withOwners(
    cores: OrganizationCore[],
  ): Promise<OrganizationResponse[]> {
    const ownersByOrg =
      await organizationMemberRepository.findOwnersByOrganizationIds(
        cores.map((c) => c.id),
      );
    const userIds = [
      ...new Set(
        [...ownersByOrg.values()].flat().map((owner) => owner.userId),
      ),
    ];
    const map = await fetchOrganizationOwnersByUserIds(userIds);
    return cores.map((c) => ({
      ...c,
      owners: (ownersByOrg.get(c.id) ?? []).map(
        (owner): OrganizationOwnerWithRoleResponse => ({
          ...(getUserProfile(map, owner.userId) ??
            this.ownerFallback(owner.userId)),
          role: owner.role,
        }),
      ),
    }));
  }

  /** Thin wrapper so every check in this file reads the same; the matrix is in `org-access`. */
  private assertPermission(
    organizationId: string,
    userId: string,
    permission: OrgPermission,
  ): Promise<string> {
    return orgAccessService.assertOrgPermission(organizationId, userId, permission);
  }

  private joinRequestResponseFromRow(
    row: {
      id: string;
      organizationId: string;
      requesterId: string;
      status: number;
      createdAt: Date;
      updatedAt: Date;
    },
    requesterById: Map<string, OrganizationOwnerResponse>,
  ): OrganizationJoinRequestResponse {
    return {
      id: row.id,
      organizationId: row.organizationId,
      requesterId: row.requesterId,
      requester:
        getUserProfile(requesterById, row.requesterId) ??
        this.ownerFallback(row.requesterId),
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toJoinRequestDetailResponse(
    r: any,
    requesterById: Map<string, OrganizationOwnerResponse>,
  ): OrganizationJoinRequestDetailResponse {
    const base = this.joinRequestResponseFromRow(r, requesterById);
    const org = r.organization;
    return {
      ...base,
      organization:
        org && !org.deletedAt
          ? {
              id: org.id,
              name: org.name,
            }
          : undefined,
    };
  }

  private async assertUniqueNameAndContactEmail(
    name: string,
    contactEmail: string,
    excludeOrganizationId?: string,
  ): Promise<void> {
    const existing =
      await organizationRepository.findActiveByNameAndContactEmail(
        name,
        contactEmail,
        excludeOrganizationId,
      );
    if (existing) {
      throw new HttpError(HTTP_STATUS.ORGANIZATION_ALREADY_EXISTS);
    }
  }

  private isUniqueSlugConflict(error: unknown): boolean {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== "P2002"
    ) {
      return false;
    }
    const target = error.meta?.target;
    if (typeof target === "string") {
      return target.includes("slug");
    }
    if (Array.isArray(target)) {
      return target.some((t) => String(t).includes("slug"));
    }
    return false;
  }

  private async allocateUniqueSlug(name: string): Promise<string> {
    const base = slugifyOrganizationName(name);
    const taken = new Set(
      await organizationRepository.findSlugsConflictingWithBase(base),
    );
    try {
      return nextUniqueOrganizationSlug(base, taken);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "organization_slug_exhausted"
      ) {
        throw new HttpError(
          HTTP_STATUS.CONFLICT.withMessage("Unable to allocate a unique slug"),
        );
      }
      throw error;
    }
  }

  async createOrganization(
    ownerId: string,
    body: CreateOrganizationBody,
    _authorization?: string,
  ): Promise<OrganizationResponse> {
    const name = body.name.trim();
    const contactEmail = body.contactEmail.trim().toLowerCase();
    await this.assertUniqueNameAndContactEmail(name, contactEmail);

    const providedVi = body.descriptionVi?.trim() || "";
    const providedEn = body.descriptionEn?.trim() || "";
    const legacy = body.description?.trim() || "";
    const sourceText = providedVi || providedEn || legacy;
    // Use the source text as a placeholder for any missing language; the
    // background translation worker overwrites it with the real translation.
    const descriptionVi: string | null = sourceText
      ? providedVi || sourceText
      : null;
    const descriptionEn: string | null = sourceText
      ? providedEn || sourceText
      : null;

    const createPayload = {
      name,
      description: descriptionVi ?? legacy ?? null,
      descriptionVi,
      descriptionEn,
      logoUrl: body.logoUrl.trim(),
      backgroundUrl: body.backgroundUrl?.trim() || null,
      contactEmail,
      ownerId,
      createdBy: ownerId,
    };

    let created: Awaited<ReturnType<typeof organizationRepository.create>> | null =
      null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const slug = await this.allocateUniqueSlug(name);
      try {
        created = await organizationRepository.create({
          ...createPayload,
          slug,
        });
        break;
      } catch (error) {
        if (this.isUniqueSlugConflict(error) && attempt < 4) {
          continue;
        }
        throw error;
      }
    }
    if (!created) {
      throw new HttpError(
        HTTP_STATUS.CONFLICT.withMessage("Unable to allocate a unique slug"),
      );
    }

    if (sourceText && (!providedVi || !providedEn)) {
      enqueueOrganizationTranslationJob(created.id, [
        {
          sourceText,
          viField: providedVi ? undefined : "descriptionVi",
          enField: providedEn ? undefined : "descriptionEn",
        },
      ]);
    }

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

    return this.withOwner(this.organizationCoreFromRow(created));
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
      organizationId,
      ownerUserId,
    });
  }

  /**
   * Confirms `contactEmail` after identity-service has validated and consumed the opaque token.
   */
  async confirmOrganizationContactEmail(
    organizationId: string,
    email: string,
  ): Promise<{ slug: string }> {
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
      return { slug: org.slug };
    }
    await organizationRepository.update(organizationId, {
      isEmailVerified: true,
    });
    return { slug: org.slug };
  }

  /**
   * Admin-only at controller: set organization lifecycle after review
   * (`status` → verified/active or banned/inactive).
   * Ban requires a non-empty `rejectReason`. Verify may omit it (clears any previous reason).
   */
  async adminVerifyOrganization(
    organizationId: string,
    adminUserId: string,
    targetStatus: GlobalStatus._STATUS_ACTIVE | GlobalStatus._STATUS_INACTIVE,
    rejectReason?: string | null,
  ): Promise<OrganizationResponse> {
    const existing = await organizationRepository.findById(organizationId);
    if (!existing) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Organization not found"),
      );
    }

    const trimmedReason =
      typeof rejectReason === "string" ? rejectReason.trim() : "";

    if (targetStatus === GlobalStatus._STATUS_ACTIVE) {
      if (existing.status === GlobalStatus._STATUS_ACTIVE) {
        return this.withOwner(this.organizationCoreFromRow(existing));
      }
      const canApprove =
        existing.status === GlobalStatus._STATUS_DRAFT ||
        existing.status === GlobalStatus._STATUS_INACTIVE ||
        existing.status === GlobalStatus._STATUS_INREVIEW ||
        existing.status === GlobalStatus._STATUS_PENDING;
      if (!canApprove) {
        throw new HttpError(
          HTTP_STATUS.BAD_REQUEST.withMessage(
            "Organization cannot be approved from its current status",
          ),
        );
      }
      const updated = await organizationRepository.update(organizationId, {
        status: GlobalStatus._STATUS_ACTIVE,
        rejectReason: trimmedReason || null,
        updatedBy: adminUserId,
      });
      this.notifyOwnerOfOrganizationVerified(updated, "approved");
      return this.withOwner(this.organizationCoreFromRow(updated));
    }

    if (!trimmedReason) {
      throw new HttpError(
        HTTP_STATUS.VALIDATION_ERROR.withMessage(
          "reject_reason is required when banning an organization",
        ),
      );
    }

    if (existing.status === GlobalStatus._STATUS_INACTIVE) {
      if (existing.rejectReason === trimmedReason) {
        return this.withOwner(this.organizationCoreFromRow(existing));
      }
      const updated = await organizationRepository.update(organizationId, {
        rejectReason: trimmedReason,
        updatedBy: adminUserId,
      });
      return this.withOwner(this.organizationCoreFromRow(updated));
    }
    const canBan =
      existing.status === GlobalStatus._STATUS_DRAFT ||
      existing.status === GlobalStatus._STATUS_PENDING ||
      existing.status === GlobalStatus._STATUS_INREVIEW ||
      existing.status === GlobalStatus._STATUS_ACTIVE;
    if (!canBan) {
      throw new HttpError(
        HTTP_STATUS.BAD_REQUEST.withMessage(
          "Organization cannot be banned from its current status",
        ),
      );
    }
    const updated = await organizationRepository.update(organizationId, {
      status: GlobalStatus._STATUS_INACTIVE,
      rejectReason: trimmedReason,
      updatedBy: adminUserId,
    });
    this.notifyOwnerOfOrganizationVerified(updated, "banned", trimmedReason);
    return this.withOwner(this.organizationCoreFromRow(updated));
  }

  /** Best-effort in-app notice to every owner after admin verify/ban. */
  private notifyOwnerOfOrganizationVerified(
    org: Organization,
    outcome: "approved" | "banned",
    rejectReason?: string,
  ): void {
    void organizationMemberRepository
      .findOwnerUserIds(org.id)
      .then((ownerIds) =>
        Promise.all(
          ownerIds.map((ownerId) =>
            outcome === "approved"
              ? enqueueOrganizationApprovedWebsiteNotification({
                  userId: ownerId,
                  organizationName: org.name,
                  organizationId: org.id,
                  organizationSlug: org.slug,
                })
              : enqueueOrganizationRejectedWebsiteNotification({
                  userId: ownerId,
                  organizationName: org.name,
                  organizationId: org.id,
                  organizationSlug: org.slug,
                  rejectReason: rejectReason ?? "",
                }),
          ),
        ),
      )
      .catch((err) => {
        console.warn(
          `[organization] failed to notify owners of organization ${outcome}`,
          err,
        );
      });
  }

  /** Owner-only: partial update; changing `contactEmail` resets verification and queues a new email. */
  async updateOrganization(
    organizationId: string,
    ownerId: string,
    body: UpdateOrganizationBody,
    _authorization?: string,
  ): Promise<OrganizationResponse> {
    const org = await organizationRepository.findById(organizationId);
    if (!org) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Organization not found"),
      );
    }
    await this.assertPermission(organizationId, ownerId, OrgPermission.ORG_EDIT);

    const prevEmailNorm = org.contactEmail?.toLowerCase().trim() ?? "";
    const nextName = body.name !== undefined ? body.name.trim() : org.name;
    const nextEmail =
      body.contactEmail !== undefined
        ? body.contactEmail.trim().toLowerCase()
        : prevEmailNorm;
    if (nextName && nextEmail) {
      await this.assertUniqueNameAndContactEmail(
        nextName,
        nextEmail,
        organizationId,
      );
    }

    const patch: Parameters<typeof organizationRepository.update>[1] = {
      updatedBy: ownerId,
    };

    if (!org.slug) {
      patch.slug = await this.allocateUniqueSlug(nextName);
    }

    if (body.name !== undefined) {
      patch.name = nextName;
    }
    if (body.description !== undefined) {
      patch.description = body.description?.trim() || null;
    }
    if (body.descriptionVi !== undefined) {
      patch.descriptionVi = body.descriptionVi?.trim() || null;
    }
    if (body.descriptionEn !== undefined) {
      patch.descriptionEn = body.descriptionEn?.trim() || null;
    }
    const userVi = body.descriptionVi?.trim() || "";
    const userEn = body.descriptionEn?.trim() || "";
    const sourceText =
      userVi || userEn || body.description?.trim() || "";
    // Pre-fill any missing language with the source text so the row reads back
    // sensibly until the translation worker overwrites it.
    if (sourceText) {
      if (patch.descriptionVi === undefined) patch.descriptionVi = sourceText;
      if (patch.descriptionEn === undefined) patch.descriptionEn = sourceText;
      if (patch.description === undefined) patch.description = sourceText;
    }
    if (body.logoUrl !== undefined) {
      patch.logoUrl = body.logoUrl.trim();
    }
    if (body.backgroundUrl !== undefined) {
      patch.backgroundUrl =
        body.backgroundUrl === null ? null : body.backgroundUrl.trim() || null;
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

    if (sourceText && (!userVi || !userEn)) {
      enqueueOrganizationTranslationJob(updated.id, [
        {
          sourceText,
          viField: userVi ? undefined : "descriptionVi",
          enField: userEn ? undefined : "descriptionEn",
        },
      ]);
    }

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

    return this.withOwner(this.organizationCoreFromRow(updated));
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
    await this.assertPermission(organizationId, ownerId, OrgPermission.ORG_EDIT);
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

    return this.withOwner(this.organizationCoreFromRow(org));
  }

  /**
   * Maps latest join-request row to API `request_status` (same numeric `JoinRequestStatus` /
   * `GlobalStatus` as stored on the request). Omitted when there is no row, the latest is
   * rejected, or the status is otherwise not exposed.
   */
  private joinRequestStatusForOrganizationDetail(
    joinRequestStatus: number | undefined,
    isMember: boolean,
  ): number | undefined {
    if (joinRequestStatus === undefined) return undefined;
    if (joinRequestStatus === JoinRequestStatus._STATUS_REJECTED) {
      return undefined;
    }
    if (
      joinRequestStatus === JoinRequestStatus._STATUS_PENDING ||
      joinRequestStatus === JoinRequestStatus._STATUS_APPROVED
    ) {
      // After leaving, we still may have a historical APPROVED join request.
      // Exposing that status prevents the client from showing the "Join" CTA.
      if (
        joinRequestStatus === JoinRequestStatus._STATUS_APPROVED &&
        !isMember
      ) {
        return undefined;
      }
      return joinRequestStatus;
    }
    return undefined;
  }

  private attachViewerJoinState(
    organization: OrganizationResponse,
    latest: { id: string; status: number } | undefined,
    role: string | null,
  ): OrganizationResponse {
    const isMember = role !== null;
    const requestStatus = this.joinRequestStatusForOrganizationDetail(
      latest?.status,
      isMember,
    );
    const next: OrganizationResponse = {
      ...organization,
      myRole: role,
      isOwner: isOwnerRole(role),
      permissions: orgAccessService.permissionsFor(role),
      ...(isMember ? { isMember } : {}),
    };
    if (requestStatus === undefined || latest === undefined) {
      return next;
    }
    return {
      ...next,
      requestStatus,
      ...(requestStatus === JoinRequestStatus._STATUS_PENDING
        ? { joinRequestId: latest.id }
        : {}),
    };
  }

  async getById(
    organizationId: string,
    viewerUserId?: string,
  ): Promise<OrganizationResponse | null> {
    const row = await organizationRepository.findById(organizationId);
    if (!row) return null;
    return this.hydrateOrganizationForViewer(row, viewerUserId);
  }

  async getBySlug(
    slug: string,
    viewerUserId?: string,
  ): Promise<OrganizationResponse | null> {
    const row = await organizationRepository.findBySlug(slug);
    if (!row || row.status === GlobalStatus._STATUS_INACTIVE) return null;
    return this.hydrateOrganizationForViewer(row, viewerUserId);
  }

  private async hydrateOrganizationForViewer(
    row: Organization,
    viewerUserId?: string,
  ): Promise<OrganizationResponse> {
    const organization = await this.withOwner(
      this.organizationCoreFromRow(row),
    );
    if (!viewerUserId) {
      return organization;
    }
    const latestJoin =
      await organizationJoiningRequestRepository.findLatestByOrganizationAndRequester(
        row.id,
        viewerUserId,
      );
    const role = await organizationMemberRepository.findActiveRole(
      row.id,
      viewerUserId,
    );
    return this.attachViewerJoinState(
      organization,
      latestJoin
        ? { id: latestJoin.id, status: latestJoin.status }
        : undefined,
      role,
    );
  }

  private async organizationIdsForJoinRequestStatusFilter(
    viewerUserId: string,
    requestStatuses: number[] | undefined,
  ): Promise<string[] | undefined> {
    if (requestStatuses === undefined || requestStatuses.length === 0) {
      return undefined;
    }
    return organizationJoiningRequestRepository.findOrganizationIdsWhereLatestJoinRequestStatusIn(
      viewerUserId,
      requestStatuses,
    );
  }

  private async withOrganizationListRequestStatus(
    organizations: OrganizationResponse[],
    viewerUserId: string,
  ): Promise<OrganizationResponse[]> {
    if (organizations.length === 0) {
      return organizations;
    }
    const roleByOrgId =
      await organizationMemberRepository.findActiveRolesForUser(
        viewerUserId,
        organizations.map((o) => o.id),
      );
    const latestByOrgId =
      await organizationJoiningRequestRepository.findLatestStatusByOrganizationForRequester(
        viewerUserId,
        organizations.map((o) => o.id),
      );
    return organizations.map((org) =>
      this.attachViewerJoinState(
        org,
        latestByOrgId.get(org.id),
        roleByOrgId.get(org.id) ?? null,
      ),
    );
  }

  private async withMemberCounts(
    organizations: OrganizationResponse[],
  ): Promise<OrganizationResponse[]> {
    if (organizations.length === 0) {
      return organizations;
    }
    const counts =
      await organizationMemberRepository.countActiveByOrganizationIds(
        organizations.map((o) => o.id),
      );
    return organizations.map((org) => ({
      ...org,
      members: counts.get(org.id) ?? 0,
    }));
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

    const joinRequestOrgIds =
      await this.organizationIdsForJoinRequestStatusFilter(
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
          isOwner: query.isOwner,
          roles: query.roles,
        },
        { skip, take: limit, sortBy, sortOrder },
      );

    const organizations = await this.withOwners(
      rows.map((r) => this.organizationCoreFromRow(r)),
    );
    return {
      organizations: await this.withMemberCounts(
        await this.withOrganizationListRequestStatus(organizations, userId),
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

    const joinRequestOrgIds =
      await this.organizationIdsForJoinRequestStatusFilter(
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

    const organizations = await this.withOwners(
      rows.map((r) => this.organizationCoreFromRow(r)),
    );
    return {
      organizations: await this.withMemberCounts(
        await this.withOrganizationListRequestStatus(
          organizations,
          viewerUserId,
        ),
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

    const isMember = await organizationMemberRepository.isActiveMember(
      organizationId,
      requesterId,
    );
    if (isMember) {
      throw new HttpError(
        HTTP_STATUS.CONFLICT.withMessage(
          "Already a member of this organization",
        ),
      );
    }

    const pending = await organizationJoiningRequestRepository.findPending(
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
    const requesterById = await fetchOrganizationOwnersByUserIds([
      row.requesterId,
    ]);

    // Everyone who may approve it hears about it, not just the owners.
    void orgAccessService
      .userIdsWith(organizationId, OrgPermission.MEMBER_APPROVE)
      .then((approverIds) =>
        Promise.all(
          approverIds.map((ownerId) =>
            this.notifyOrganizationOwnerOfJoinRequest({
              ownerId,
              organizationId,
              organizationSlug: org.slug,
              organizationName: org.name,
              requesterId: row.requesterId,
              requesterById,
            }),
          ),
        ),
      )
      .catch((err) => {
        console.warn(
          "[organization] failed to notify owners of join request",
          err,
        );
      });

    return this.joinRequestResponseFromRow(row, requesterById);
  }

  /**
   * Notify org owner when a user requests to join the organization.
   */
  private async notifyOrganizationOwnerOfJoinRequest(params: {
    ownerId: string;
    organizationId: string;
    organizationSlug: string;
    organizationName: string;
    requesterId: string;
    requesterById: ReadonlyMap<string, OrganizationOwnerResponse>;
  }): Promise<void> {
    const reqProfile = getUserProfile(params.requesterById, params.requesterId);
    const volunteerName = reqProfile?.name?.trim() || "Someone";

    await enqueueVolunteerRequestWebsiteNotification({
      userId: params.ownerId,
      volunteerName,
      reportTitle: params.organizationName,
      organizationId: params.organizationId,
      organizationSlug: params.organizationSlug,
    });
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
    await this.assertPermission(
      organizationId,
      ownerId,
      OrgPermission.MEMBER_APPROVE,
    );

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

    const requesterById = await fetchOrganizationOwnersByUserIds([
      ...new Set(rows.map((r) => r.requesterId)),
    ]);

    return {
      joinRequests: rows.map((r) =>
        this.joinRequestResponseFromRow(r, requesterById),
      ),
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

    const requesterById = await fetchOrganizationOwnersByUserIds([
      ...new Set(rows.map((r) => r.requesterId)),
    ]);

    return {
      joinRequests: rows.map((r) =>
        this.toJoinRequestDetailResponse(r, requesterById),
      ),
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

    await this.assertPermission(
      request.organizationId,
      ownerId,
      OrgPermission.MEMBER_APPROVE,
    );

    if (request.status !== JoinRequestStatus._STATUS_PENDING) {
      throw new HttpError(HTTP_STATUS.JOIN_REQUEST_ALREADY_PROCESSED);
    }

    if (status === JoinRequestStatus._STATUS_APPROVED) {
      await prisma.$transaction(async (tx) => {
        await tx.organizationJoiningRequest.update({
          where: { id: requestId },
          data: { status },
        });
        await organizationMembershipService.grantMembership(tx, {
          userId: request.requesterId,
          organizationId: request.organizationId,
          role: OrgMemberRole.MEMBER,
          source: MembershipSource.JOIN_REQUEST,
          sourceRef: request.id,
          actorId: ownerId,
        });
      });
      void enqueueVolunteerApprovedWebsiteNotification({
        userId: request.requesterId,
        reportTitle: request.organization.name,
        organizationId: request.organizationId,
        organizationSlug: request.organization.slug ?? undefined,
      }).catch((err) => {
        console.warn(
          "[organization] failed to notify requester of join approval",
          err,
        );
      });
    } else {
      await organizationJoiningRequestRepository.updateStatus(
        requestId,
        status,
      );
      void enqueueVolunteerRejectedWebsiteNotification({
        userId: request.requesterId,
        reportTitle: request.organization.name,
        organizationId: request.organizationId,
        organizationSlug: request.organization.slug ?? undefined,
      }).catch((err) => {
        console.warn(
          "[organization] failed to notify requester of join rejection",
          err,
        );
      });
    }

    const updated =
      await organizationJoiningRequestRepository.findById(requestId);
    if (!updated) {
      throw new HttpError(HTTP_STATUS.JOIN_REQUEST_NOT_FOUND);
    }
    const requesterById = await fetchOrganizationOwnersByUserIds([
      updated.requesterId,
    ]);
    return this.joinRequestResponseFromRow(updated, requesterById);
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
    // ownerId: string,
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
    // if (org.ownerId !== ownerId) {
    //   throw new HttpError(
    //     HTTP_STATUS.FORBIDDEN.withMessage(
    //       "Only the organization owner can list members",
    //     ),
    //   );
    // }

    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const sortBy = query.sortBy ?? "createdAt";
    const sortOrder = query.sortOrder ?? "desc";
    const skip = (page - 1) * limit;

    const searchTerm = query.search?.trim();
    if (searchTerm) {
      let rows =
        await organizationMemberRepository.findAllActiveByOrganization(
          organizationId,
        );
      if (query.userId) {
        rows = rows.filter((r) => r.userId === query.userId);
      }
      const distinctUserIds = [...new Set(rows.map((r) => r.userId))];
      const profiles = await fetchOrganizationOwnersByUserIds(distinctUserIds);
      const needle = searchTerm.toLowerCase();
      let matched = rows.filter((r) => {
        const name =
          getUserProfile(profiles, r.userId)?.name?.toLowerCase() ?? "";
        return name.includes(needle);
      });

      const dir = sortOrder === "asc" ? 1 : -1;
      matched.sort((a, b) => {
        const av =
          sortBy === "updatedAt"
            ? a.updatedAt.getTime()
            : a.createdAt.getTime();
        const bv =
          sortBy === "updatedAt"
            ? b.updatedAt.getTime()
            : b.createdAt.getTime();
        return (av - bv) * dir;
      });

      const total = matched.length;
      const pageRows = matched.slice(skip, skip + limit);
      const members: OrganizationMemberResponse[] = pageRows.map((r) => ({
        organizationId: r.organizationId,
        userId: r.userId,
        role: r.role,
        user:
          getUserProfile(profiles, r.userId) ?? this.ownerFallback(r.userId),
        createdAt: r.createdAt,
      }));

      return {
        members,
        total,
        page,
        limit,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      };
    }

    const { rows, total } =
      await organizationMemberRepository.findByOrganizationPaginated(
        organizationId,
        { userId: query.userId },
        { skip, take: limit, sortBy, sortOrder },
      );

    const userById = await fetchOrganizationOwnersByUserIds(
      rows.map((r) => r.userId),
    );

    const members: OrganizationMemberResponse[] = rows.map((r) => ({
      organizationId: r.organizationId,
      userId: r.userId,
      role: r.role,
      user: getUserProfile(userById, r.userId) ?? this.ownerFallback(r.userId),
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

  /**
   * Change a member's role. Owners are out of reach here (becoming one is an ADD_OWNER
   * application, losing it is phase 3); an admin cannot touch another admin, and only an
   * owner may hand out ADMIN.
   */
  async changeMemberRole(
    organizationId: string,
    actorId: string,
    targetUserId: string,
    newRole: string,
  ): Promise<OrganizationMemberResponse> {
    const actorRole = await this.assertPermission(
      organizationId,
      actorId,
      OrgPermission.MEMBER_MANAGE,
    );
    if (!orgAccessService.permissionsFor(actorRole).assignableRoles.includes(
      newRole as OrgMemberRole,
    )) {
      throw new HttpError(HTTP_STATUS.ROLE_NOT_ASSIGNABLE);
    }
    const targetRole = await orgAccessService.getRole(organizationId, targetUserId);
    if (!targetRole) {
      throw new HttpError(HTTP_STATUS.MEMBER_NOT_FOUND);
    }
    if (targetUserId === actorId || !canActOnMember(actorRole, targetRole)) {
      throw new HttpError(HTTP_STATUS.CANNOT_ACT_ON_MEMBER);
    }

    const org = await organizationRepository.findById(organizationId);
    const row = await prisma.$transaction((tx) =>
      organizationMembershipService.changeRole(tx, {
        organizationId,
        userId: targetUserId,
        role: newRole as OrgMemberRole,
        actorId,
      }),
    );

    if (org && targetRole !== newRole) {
      void enqueueOrgMembershipChangedWebsiteNotification({
        userId: targetUserId,
        organizationId,
        organizationName: org.name,
        organizationSlug: org.slug,
        role: newRole,
      }).catch((err) => {
        console.warn("[organization] failed to notify member of role change", err);
      });
    }

    const profiles = await fetchOrganizationOwnersByUserIds([targetUserId]);
    return {
      organizationId: row.organizationId,
      userId: row.userId,
      role: row.role,
      user:
        getUserProfile(profiles, targetUserId) ?? this.ownerFallback(targetUserId),
      createdAt: row.createdAt,
    };
  }

  /** Remove a non-owner member (soft delete). Same bounds as `changeMemberRole`. */
  async removeMember(
    organizationId: string,
    actorId: string,
    targetUserId: string,
  ): Promise<void> {
    const actorRole = await this.assertPermission(
      organizationId,
      actorId,
      OrgPermission.MEMBER_MANAGE,
    );
    const targetRole = await orgAccessService.getRole(organizationId, targetUserId);
    if (!targetRole) {
      throw new HttpError(HTTP_STATUS.MEMBER_NOT_FOUND);
    }
    if (targetUserId === actorId || !canActOnMember(actorRole, targetRole)) {
      throw new HttpError(HTTP_STATUS.CANNOT_ACT_ON_MEMBER);
    }

    await organizationMemberRepository.softDeleteMembership(
      organizationId,
      targetUserId,
      actorId,
    );

    const org = await organizationRepository.findById(organizationId);
    if (org) {
      void enqueueOrgMembershipChangedWebsiteNotification({
        userId: targetUserId,
        organizationId,
        organizationName: org.name,
        organizationSlug: org.slug,
        removed: true,
      }).catch((err) => {
        console.warn("[organization] failed to notify removed member", err);
      });
    }
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
    const role = await organizationMemberRepository.findActiveRole(
      organizationId,
      userId,
    );
    if (isOwnerRole(role)) {
      const owners = await organizationMemberRepository.findOwnerUserIds(
        organizationId,
      );
      // Leaving as an owner is part of the exit flow (revoke / transfer), which is not
      // designed yet; the last owner can never leave (the DB refuses it as well).
      throw new HttpError(
        owners.length <= 1
          ? HTTP_STATUS.ORG_MUST_HAVE_OWNER
          : HTTP_STATUS.BAD_REQUEST.withMessage(
              "Organization owners cannot leave yet; ownership changes go through the platform",
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
