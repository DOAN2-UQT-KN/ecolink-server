import { Prisma } from "@prisma/client";
import type { AppLocale } from "@da2/constants";
import prisma from "../../config/prisma.client";
import {
  ReportJobType,
  TranslationResourceType,
  type TranslationFieldTarget,
} from "../../constants/job-type.enum";
import { backgroundJobDispatcher } from "../../queue/register";
import {
  GlobalStatus,
  JoinRequestStatus,
  ReportStatus,
  SavedResourceType,
  VoteResourceType,
} from "../../constants/status.enum";
import { HttpError, HTTP_STATUS } from "../../constants/http-status";
import { organizationRepository } from "../organization/organization.repository";
import { organizationMemberRepository } from "../organization/organization_member.repository";
import {
  enqueueCampaignCompletionPendingAdminWebsiteNotification,
  enqueueWebsiteNotificationsToUsers,
} from "./notification-jobs.client";
import { getCampaignCompletionAdminNotifyUserIds } from "./campaign-completion-admin-notify.config";
import { campaignManagerRepository } from "./campaign_manager/campaign_manager.repository";
import { rewardServiceClient } from "../reward/reward-service.client";
import { campaignJoiningRequestRepository } from "./campaign_joining_request/campaign_joining_request.repository";
import { campaignAttendanceRepository } from "./campaign_attendance/campaign_attendance.repository";
import { campaignRepository } from "./campaign.repository";
import {
  CampaignListQuery,
  CampaignMultiSubmissionReviewListQuery,
  CampaignResponse,
  CampaignWithAwaitingSubmissionCount,
  CreateCampaignRequest,
  UpdateCampaignRequest,
} from "./campaign.dto";
import { CampaignWithReports, toCampaignResponse } from "./campaign.entity";
import {
  campaignNameNotificationPayload,
  campaignTitleNotificationPayload,
} from "./campaign-i18n";
import { savedResourceRepository } from "../saved_resource/saved_resource.repository";
import { defaultResourceVoteSummary } from "../vote/vote.dto";
import { voteService } from "../vote/vote.service";
import {
  defaultCampaignCompletionVerificationSummary,
} from "./campaign_completion_verification/campaign_completion_verification.dto";
import { campaignCompletionVerificationService } from "./campaign_completion_verification/campaign_completion_verification.service";
import {
  fetchOrganizationOwnersByUserIds,
  fetchUserIdsNearPoint,
  getUserProfile,
} from "../organization/identity-user.client";
import type { OrganizationOwnerResponse } from "../organization/organization.dto";
import { toReportResponse } from "../report/report.entity";
import type { ReportResponse } from "../report/report.dto";
import { reportService } from "../report/report.service";
import { reportRepository } from "../report/report.repository";
import { emitOutbox } from "../../outbox/outbox.writer";
import { OutboxEventType } from "../../outbox/outbox.types";

/** Hardcoded radius for community verify invites (meters). */
const NOTIFY_NEARBY_VERIFY_RADIUS_METERS = 5_000;

function enqueueCampaignTranslationJob(
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
      resourceType: TranslationResourceType.CAMPAIGN,
      resourceId,
      translations: cleaned,
    })
    .catch((err: Error) => {
      console.error(
        "[incident-service] Failed to enqueue campaign translation job:",
        err.message,
      );
    });
}

export class CampaignService {
  constructor() {}

  private debugWarn(message: string, meta?: Record<string, unknown>): void {
    if (process.env.NODE_ENV === "production") return;
    console.warn(`[campaign] ${message}`, meta ?? {});
  }

  private async resolveTierMaps(levels: number[]): Promise<{
    greenByLevel: Map<number, number>;
    maxByLevel: Map<number, number | null>;
    difficulties: { level: number; greenPoints: number; maxVolunteers: number | null }[];
  }> {
    const unique = [...new Set(levels)].filter((l) => Number.isFinite(l));
    const difficulties = await rewardServiceClient.getDifficulties();
    if (difficulties.length > 0) {
      return {
        greenByLevel: new Map(difficulties.map((d) => [d.level, d.greenPoints])),
        maxByLevel: new Map(
          difficulties.map((d) => [d.level, d.maxVolunteers]),
        ),
        difficulties,
      };
    }

    // Fallback: list endpoint unavailable, but per-level may still work.
    if (unique.length > 0) {
      this.debugWarn("reward difficulties list empty; falling back to per-level", {
        levels: unique,
      });
    }
    const tiers = await Promise.all(
      unique.map((level) => rewardServiceClient.getDifficultyByLevel(level)),
    );
    const resolved = tiers.filter((t): t is NonNullable<typeof t> => t != null);
    return {
      greenByLevel: new Map(resolved.map((d) => [d.level, d.greenPoints])),
      maxByLevel: new Map(resolved.map((d) => [d.level, d.maxVolunteers])),
      difficulties: resolved,
    };
  }

  private ownerFallback(userId: string): OrganizationOwnerResponse {
    return { id: userId, name: "", avatar: null, bio: null };
  }

  private async enrichCampaignsForGet(
    campaigns: CampaignResponse[],
    viewerUserId?: string | null,
  ): Promise<CampaignResponse[]> {
    if (campaigns.length === 0) {
      return campaigns;
    }

    const campaignIds = campaigns.map((campaign) => campaign.id);
    const organizationIds = [
      ...new Set(
        campaigns
          .map((c) => c.organizationId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const managerIds = [
      ...new Set(
        campaigns.flatMap((campaign) =>
          campaign.managers.map((manager) => manager.id),
        ),
      ),
    ];

    const [organizations, reportsByCampaignId] = await Promise.all([
      organizationRepository.findManyByIds(organizationIds).catch(() => []),
      this.getReportsByCampaignIds(campaignIds, viewerUserId),
    ]);

    // The person who created the campaign on the organization's behalf. An organization
    // never logs in, so this is always a real user.
    const creatorIds = [
      ...new Set(
        campaigns
          .map((c) => c.createdBy)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const identityUserIds = [...new Set([...managerIds, ...creatorIds])];
    const profileMap = await fetchOrganizationOwnersByUserIds(identityUserIds);

    const organizationMap = new Map(
      organizations.map((org) => [
        org.id,
        {
          background_url: org.backgroundUrl,
          contact_email: org.contactEmail,
          logo_url: org.logoUrl,
          name: org.name,
          slug: org.slug,
        },
      ]),
    );

    return campaigns.map((campaign) => {
      const orgRow = organizationMap.get(campaign.organizationId);
      const orgOwner = campaign.createdBy
        ? (getUserProfile(profileMap, campaign.createdBy) ??
          this.ownerFallback(campaign.createdBy))
        : null;
      const organization = orgRow
        ? {
            background_url: orgRow.background_url,
            contact_email: orgRow.contact_email,
            logo_url: orgRow.logo_url,
            name: orgRow.name,
            slug: orgRow.slug,
          }
        : undefined;

      const canManageCampaign =
        viewerUserId != null &&
        (campaign.createdBy === viewerUserId ||
          campaign.managers.some((m) => m.id === viewerUserId));

      return {
        ...campaign,
        owner: orgOwner,
        Organization: organization,
        reports: reportsByCampaignId.get(campaign.id) ?? [],
        managers: campaign.managers.map((manager) => {
          const profile = getUserProfile(profileMap, manager.id);
          return {
            id: manager.id,
            name: profile?.name ?? "",
            avatar: profile?.avatar ?? null,
          };
        }),
        ...(viewerUserId != null ? { canManageCampaign } : {}),
      };
    });
  }

  private async getReportsByCampaignIds(
    campaignIds: string[],
    viewerUserId?: string | null,
  ): Promise<Map<string, ReportResponse[]>> {
    const out = new Map<string, ReportResponse[]>();
    if (campaignIds.length === 0) {
      return out;
    }

    const rows = await prisma.report.findMany({
      where: {
        campaignId: { in: campaignIds },
        deletedAt: null,
      },
      orderBy: { createdAt: "desc" },
    });

    let reportResponses = rows.map((row) => toReportResponse(row));
    if (reportResponses.length > 0) {
      const ids = reportResponses.map((report) => report.id);
      const [voteMap, savedIds] = await Promise.all([
        voteService.getVoteSummariesForResources(
          VoteResourceType.REPORT,
          ids,
          viewerUserId ?? null,
        ),
        viewerUserId
          ? savedResourceRepository.findActiveSavedResourceIdsForUser(
              viewerUserId,
              SavedResourceType.REPORT,
              ids,
            )
          : Promise.resolve(new Set<string>()),
      ]);
      reportResponses = reportResponses.map((report) => ({
        ...report,
        votes:
          voteMap.get(report.id) ??
          defaultResourceVoteSummary(viewerUserId ?? null),
        saved: viewerUserId != null ? savedIds.has(report.id) : null,
      }));
      reportResponses =
        await reportService.attachReporterProfilesToReports(reportResponses);
    }

    const byId = new Map(reportResponses.map((report) => [report.id, report]));
    for (const row of rows) {
      const mapped = byId.get(row.id);
      if (!mapped) continue;
      const list = out.get(row.campaignId ?? "");
      if (!list) {
        out.set(row.campaignId ?? "", [mapped]);
      } else {
        list.push(mapped);
      }
    }

    return out;
  }

  private async toResponse(
    entity: CampaignWithReports,
    locale?: AppLocale | null,
  ): Promise<CampaignResponse> {
    const [tier, currentMembers] = await Promise.all([
      rewardServiceClient.getDifficultyByLevel(entity.difficulty),
      campaignJoiningRequestRepository.countApprovedByCampaignId(entity.id),
    ]);
    if (!tier) {
      this.debugWarn("missing reward tier for campaign difficulty", {
        campaignId: entity.id,
        difficulty: entity.difficulty,
      });
    }
    const greenPoints = tier?.greenPoints ?? 0;
    const maxMembers = tier?.maxVolunteers ?? null;
    return toCampaignResponse(
      entity,
      greenPoints,
      currentMembers,
      maxMembers,
      locale,
    );
  }

  private async withCampaignVotes(
    campaigns: CampaignResponse[],
    viewerUserId?: string | null,
  ): Promise<CampaignResponse[]> {
    if (campaigns.length === 0) {
      return campaigns;
    }
    const ids = campaigns.map((c) => c.id);
    const [map, verificationMap, savedIds] = await Promise.all([
      voteService.getVoteSummariesForResources(
        VoteResourceType.CAMPAIGN,
        ids,
        viewerUserId ?? null,
      ),
      campaignCompletionVerificationService.getSummariesForCampaigns(
        ids,
        viewerUserId ?? null,
      ),
      viewerUserId
        ? savedResourceRepository.findActiveSavedResourceIdsForUser(
            viewerUserId,
            SavedResourceType.CAMPAIGN,
            ids,
          )
        : Promise.resolve(new Set<string>()),
    ]);
    return campaigns.map((c) => ({
      ...c,
      votes: map.get(c.id) ?? defaultResourceVoteSummary(viewerUserId ?? null),
      completionVerification:
        verificationMap.get(c.id) ??
        defaultCampaignCompletionVerificationSummary(viewerUserId ?? null),
      saved: viewerUserId != null ? savedIds.has(c.id) : null,
    }));
  }

  private async toResponseWithVotes(
    entity: CampaignWithReports,
    viewerUserId?: string | null,
    locale?: AppLocale | null,
  ): Promise<CampaignResponse> {
    const base = await this.toResponse(entity, locale);
    const [one] = await this.withCampaignVotes([base], viewerUserId);
    return one;
  }

  private joinRequestStatusForCampaignDetail(
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

  private async withCampaignListRequestStatus(
    campaigns: CampaignResponse[],
    viewerUserId: string,
  ): Promise<CampaignResponse[]> {
    if (campaigns.length === 0) {
      return campaigns;
    }
    const statusByCampaignId =
      await campaignJoiningRequestRepository.findLatestStatusByCampaignForVolunteer(
        viewerUserId,
        campaigns.map((c) => c.id),
      );
    return campaigns.map((campaign) => {
      const requestStatus = this.joinRequestStatusForCampaignDetail(
        statusByCampaignId.get(campaign.id),
      );
      return requestStatus !== undefined
        ? { ...campaign, requestStatus }
        : campaign;
    });
  }

  async createCampaign(
    userId: string,
    request: CreateCampaignRequest,
    viewerUserId?: string | null,
  ): Promise<CampaignResponse> {
    const org = await organizationRepository.findById(request.organizationId);
    if (!org) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Organization not found"),
      );
    }
    const isOwner = await organizationMemberRepository.isOwner(org.id, userId);
    if (!isOwner) {
      throw new HttpError(
        HTTP_STATUS.FORBIDDEN.withMessage(
          "Only an organization owner can create campaigns",
        ),
      );
    }

    const tier = await rewardServiceClient.getDifficultyByLevel(
      request.difficulty,
    );
    if (!tier) {
      throw new Error(
        "Invalid campaign difficulty; no matching tier in reward service",
      );
    }

    const reportIds = this.normalizeReportIds(request.reportIds);
    const managerIds = [userId];
    await this.validateReportIds(reportIds);

    const sourceTitle = request.title.trim();
    const titleVi =
      request.titleVi?.trim() || request.titleEn?.trim() || sourceTitle;
    const titleEn =
      request.titleEn?.trim() || request.titleVi?.trim() || sourceTitle;
    const sourceDesc = request.description?.trim() ?? "";
    const descriptionVi =
      request.descriptionVi?.trim() ||
      request.descriptionEn?.trim() ||
      sourceDesc ||
      null;
    const descriptionEn =
      request.descriptionEn?.trim() ||
      request.descriptionVi?.trim() ||
      sourceDesc ||
      null;

    const created = await prisma.$transaction(
      async (tx) => {
        const campaign = await tx.campaign.create({
          data: {
            title: sourceTitle,
            titleVi,
            titleEn,
            banner: request.banner,
            description: sourceDesc || null,
            descriptionVi,
            descriptionEn,
            startDate: request.startDate ? new Date(request.startDate) : null,
            endDate: request.endDate ? new Date(request.endDate) : null,
            detailAddress: request.detailAddress,
            latitude: request.latitude,
            longitude: request.longitude,
            radiusKm: request.radiusKm,
            difficulty: request.difficulty,
            status: GlobalStatus._STATUS_PENDING,
            organizationId: request.organizationId,
            createdBy: userId,
            updatedBy: userId,
          } as any,
        });

        await this.assignManagersToCampaign(
          tx,
          campaign.id,
          managerIds,
          userId,
        );

        // Campaign ownership is manager ownership. Do not create report managers here.
        await this.assignReportsToCampaign(tx, campaign.id, reportIds);

        return tx.campaign.findFirst({
          where: { id: campaign.id, deletedAt: null },
          include: {
            campaignManagers: {
              where: { deletedAt: null },
              select: { userId: true },
            },
            reports: {
              where: { deletedAt: null },
              select: { id: true },
            },
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );

    if (!created) {
      throw new Error("Failed to create campaign");
    }

    enqueueCampaignTranslationJob(created.id, [
      {
        sourceText: sourceTitle,
        viField: "titleVi",
        enField: "titleEn",
      },
      ...(sourceDesc
        ? [
            {
              sourceText: sourceDesc,
              viField: "descriptionVi",
              enField: "descriptionEn",
            },
          ]
        : []),
    ]);

    void this.notifyOrganizationMembersOfNewCampaign({
      organizationId: org.id,
      organizationName: org.name,
      campaign: created,
      creatorUserId: userId,
    }).catch((err) => {
      console.warn(
        "[campaign] failed to notify organization members of new campaign",
        err,
      );
    });

    return this.toResponseWithVotes(created, viewerUserId ?? userId);
  }

  /** In-app: approved org members (except the creator) when a new campaign is created. */
  private async notifyOrganizationMembersOfNewCampaign(args: {
    organizationId: string;
    organizationName: string;
    campaign: {
      id: string;
      title: string;
      titleVi?: string | null;
      titleEn?: string | null;
    };
    creatorUserId: string;
  }): Promise<void> {
    const members =
      await organizationMemberRepository.findAllActiveByOrganization(
        args.organizationId,
      );
    const recipientIds = [
      ...new Set(members.map((m) => m.userId).filter(Boolean)),
    ].filter((id) => id !== args.creatorUserId);
    if (recipientIds.length === 0) {
      return;
    }

    await enqueueWebsiteNotificationsToUsers({
      kind: "CAMPAIGN_CREATED",
      userIds: recipientIds,
      payload: {
        organizationName: args.organizationName,
        organizationId: args.organizationId,
        campaignId: args.campaign.id,
        ...campaignTitleNotificationPayload(args.campaign),
      },
    });
  }

  /**
   * Notifies citizens near the campaign point: users with a saved location (identity-service)
   * and/or users who filed geolocated reports in the area (`reportRepository`).
   */
  private async notifyNearbyCitizensForCampaignVerify(args: {
    kind: "CAMPAIGN_VERIFY_INVITE" | "CAMPAIGN_COMPLETION_VERIFY_INVITE";
    campaignId: string;
    campaign: {
      title: string;
      titleVi?: string | null;
      titleEn?: string | null;
    };
    latitude?: number | null;
    longitude?: number | null;
    excludeUserIds: string[];
  }): Promise<void> {
    if (args.latitude == null || args.longitude == null) {
      console.warn(
        "[campaign] nearby verify notify skipped: latitude/longitude required",
        { campaignId: args.campaignId, kind: args.kind },
      );
      return;
    }

    const exclude = new Set(
      args.excludeUserIds.map((id) => id?.toLowerCase().trim()).filter(Boolean),
    );

    const [fromSavedLocation, fromReports] = await Promise.all([
      fetchUserIdsNearPoint({
        latitude: args.latitude,
        longitude: args.longitude,
        radiusMeters: NOTIFY_NEARBY_VERIFY_RADIUS_METERS,
        excludeUserIds: [...exclude],
      }),
      reportRepository.findDistinctReporterUserIdsNearPoint(
        args.longitude,
        args.latitude,
        NOTIFY_NEARBY_VERIFY_RADIUS_METERS,
      ),
    ]);

    const recipientIds = [
      ...new Set(
        [...fromSavedLocation, ...fromReports].filter(
          (id) => id && !exclude.has(id.toLowerCase().trim()),
        ),
      ),
    ];

    if (recipientIds.length === 0) {
      return;
    }

    await enqueueWebsiteNotificationsToUsers({
      kind: args.kind,
      userIds: recipientIds,
      payload: {
        campaignId: args.campaignId,
        ...campaignTitleNotificationPayload(args.campaign),
      },
    });
  }

  /** After admin approves a campaign: invite nearby citizens to join as volunteers. */
  private async notifyNearbyCitizensToJoinApprovedCampaign(args: {
    campaign: {
      id: string;
      title: string;
      titleVi?: string | null;
      titleEn?: string | null;
      latitude: number | null;
      longitude: number | null;
      createdBy: string | null;
    };
    adminUserId: string;
  }): Promise<void> {
    const [managerRows] = await Promise.all([
      campaignManagerRepository.findManagersByCampaignId(args.campaign.id),
    ]);
    const excludeUserIds = [
      args.adminUserId,
      ...(args.campaign.createdBy ? [args.campaign.createdBy] : []),
      ...managerRows.map((m) => m.userId),
    ];

    await this.notifyNearbyCitizensForCampaignVerify({
      kind: "CAMPAIGN_VERIFY_INVITE",
      campaignId: args.campaign.id,
      campaign: args.campaign,
      latitude: args.campaign.latitude,
      longitude: args.campaign.longitude,
      excludeUserIds,
    });
  }

  async getCampaignById(
    id: string,
    viewerUserId?: string | null,
    locale?: AppLocale | null,
  ): Promise<CampaignResponse | null> {
    const campaign = await campaignRepository.findById(id);
    if (!campaign) return null;
    const baseRaw = await this.toResponseWithVotes(
      campaign,
      viewerUserId,
      locale,
    );
    const [base] = await this.enrichCampaignsForGet([baseRaw], viewerUserId);
    if (!viewerUserId) {
      return base;
    }
    const latestJoin =
      await campaignJoiningRequestRepository.findLatestByCampaignAndVolunteer(
        id,
        viewerUserId,
      );

    const requestStatus = this.joinRequestStatusForCampaignDetail(
      latestJoin?.status,
    );
    return requestStatus !== undefined ? { ...base, requestStatus } : base;
  }

  /** campaignIds limited to 100 UUIDs at the controller. */
  async getCampaignsByIds(
    campaignIds: string[],
    viewerUserId?: string | null,
    locale?: AppLocale | null,
  ): Promise<CampaignResponse[]> {
    if (campaignIds.length === 0) {
      return [];
    }
    const rows = await campaignRepository.findManyByIds(campaignIds);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const resolved = campaignIds
      .map((id) => byId.get(id))
      .filter((row): row is CampaignWithReports => row !== undefined);

    const { greenByLevel, maxByLevel } = await this.resolveTierMaps(
      resolved.map((c) => c.difficulty),
    );

    if (resolved.length > 0) {
      const levels = [...new Set(resolved.map((r) => r.difficulty))];
      const missing = levels.filter((l) => !greenByLevel.has(l));
      if (missing.length > 0) {
        this.debugWarn("missing greenPoints mapping for difficulties in by-ids", {
          missing,
          levels,
        });
      }
    }

    const approvedByCampaignId =
      await campaignJoiningRequestRepository.countApprovedByCampaignIds(
        resolved.map((c) => c.id),
      );
    const loc = locale ?? "en";
    const list = resolved.map((campaign) =>
      toCampaignResponse(
        campaign,
        greenByLevel.get(campaign.difficulty) ?? 0,
        approvedByCampaignId.get(campaign.id) ?? 0,
        maxByLevel.get(campaign.difficulty) ?? null,
        loc,
      ),
    );
    const withVotes = await this.withCampaignVotes(list, viewerUserId);
    return this.enrichCampaignsForGet(withVotes, viewerUserId);
  }

  async getCampaigns(
    query: CampaignListQuery,
    viewerUserId?: string | null,
    myCampaignsUserId?: string,
    excludeMyCampaignsUserId?: string,
  ): Promise<{
    campaigns: CampaignResponse[];
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

    const { difficulties, greenByLevel, maxByLevel } =
      await this.resolveTierMaps([]);

    let difficultyLevels: number[] | undefined;
    if (
      query.greenPointsFrom !== undefined ||
      query.greenPointsTo !== undefined
    ) {
      difficultyLevels = difficulties
        .filter((d) => {
          if (
            query.greenPointsFrom !== undefined &&
            d.greenPoints < query.greenPointsFrom
          )
            return false;
          if (
            query.greenPointsTo !== undefined &&
            d.greenPoints > query.greenPointsTo
          )
            return false;
          return true;
        })
        .map((d) => d.level);
      if (difficultyLevels.length === 0) {
        return { campaigns: [], total: 0, page, limit, totalPages: 0 };
      }
    }

    const { rows, total } = await campaignRepository.findManyPaginated({
      filters: {
        search: query.search,
        status: query.status,
        statuses: query.statuses,
        createdBy: query.createdBy,
        managerId: query.managerId,
        organizationId: query.organizationId,
        latitude: query.latitude,
        longitude: query.longitude,
        radiusKm: query.radiusKm,
        difficulty: query.difficulty,
        difficultyLevels,
        myCampaignsUserId,
        excludeMyCampaignsUserId,
        isOwner: query.isOwner,
      },
      skip,
      take: limit,
      sortBy,
      sortOrder,
    });

    const approvedByCampaignId =
      await campaignJoiningRequestRepository.countApprovedByCampaignIds(
        rows.map((c) => c.id),
      );

    // If the global list wasn't available, resolve only the levels we need for this page.
    const tierMaps =
      difficulties.length > 0
        ? { greenByLevel, maxByLevel }
        : await this.resolveTierMaps(rows.map((r) => r.difficulty));

    if (rows.length > 0) {
      const levels = [...new Set(rows.map((r) => r.difficulty))];
      const missing = levels.filter((l) => !tierMaps.greenByLevel.has(l));
      if (missing.length > 0) {
        this.debugWarn("missing greenPoints mapping for difficulties in list", {
          missing,
          levels,
        });
      }
    }

    const locale = query.lang ?? "en";
    const campaigns = rows.map((campaign) =>
      toCampaignResponse(
        campaign,
        tierMaps.greenByLevel.get(campaign.difficulty) ?? 0,
        approvedByCampaignId.get(campaign.id) ?? 0,
        tierMaps.maxByLevel.get(campaign.difficulty) ?? null,
        locale,
      ),
    );
    const campaignsWithVotes = await this.withCampaignVotes(
      campaigns,
      viewerUserId,
    );
    const enriched = await this.enrichCampaignsForGet(
      campaignsWithVotes,
      viewerUserId,
    );
    const campaignsWithRequestStatus =
      viewerUserId != null && viewerUserId !== ""
        ? await this.withCampaignListRequestStatus(enriched, viewerUserId)
        : enriched;
    return {
      campaigns: campaignsWithRequestStatus,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * All campaigns with status ACTIVE (`GlobalStatus._STATUS_ACTIVE`), no pagination.
   */
  async getAllActiveCampaigns(viewerUserId?: string | null): Promise<{
    campaigns: CampaignResponse[];
  }> {
    const rows = await campaignRepository.findAllActive({
      sortBy: "createdAt",
      sortOrder: "desc",
    });
    if (rows.length === 0) {
      return { campaigns: [] };
    }

    const approvedByCampaignId =
      await campaignJoiningRequestRepository.countApprovedByCampaignIds(
        rows.map((c) => c.id),
      );

    const tierMaps = await this.resolveTierMaps(rows.map((r) => r.difficulty));

    const campaigns = rows.map((campaign) =>
      toCampaignResponse(
        campaign,
        tierMaps.greenByLevel.get(campaign.difficulty) ?? 0,
        approvedByCampaignId.get(campaign.id) ?? 0,
        tierMaps.maxByLevel.get(campaign.difficulty) ?? null,
      ),
    );
    const campaignsWithVotes = await this.withCampaignVotes(
      campaigns,
      viewerUserId,
    );
    const enriched = await this.enrichCampaignsForGet(
      campaignsWithVotes,
      viewerUserId,
    );
    const campaignsWithRequestStatus =
      viewerUserId != null && viewerUserId !== ""
        ? await this.withCampaignListRequestStatus(enriched, viewerUserId)
        : enriched;

    return { campaigns: campaignsWithRequestStatus };
  }

  async getMyCampaigns(
    query: CampaignListQuery,
    userId: string,
  ): Promise<{
    campaigns: CampaignResponse[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    return this.getCampaigns(query, userId, userId);
  }

  /**
   * Admin dashboard: campaigns with more than one submission still awaiting
   * manager approve/reject.
   */
  async getCampaignsAwaitingMultiSubmissionReview(
    query: CampaignMultiSubmissionReviewListQuery,
    viewerUserId?: string | null,
  ): Promise<{
    campaigns: CampaignWithAwaitingSubmissionCount[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const sortBy = query.sortBy ?? "updatedAt";
    const sortOrder = query.sortOrder ?? "desc";
    const skip = (page - 1) * limit;

    const pairs =
      await campaignRepository.findCampaignIdsWithMultipleAwaitingSubmissions();
    const total = pairs.length;
    if (total === 0) {
      return {
        campaigns: [],
        total: 0,
        page,
        limit,
        totalPages: 0,
      };
    }

    const countById = new Map(
      pairs.map((p) => [p.campaignId, p.awaitingSubmissionCount]),
    );

    const orderBy: Prisma.CampaignOrderByWithRelationInput =
      sortBy === "title"
        ? { title: sortOrder }
        : sortBy === "updatedAt"
          ? { updatedAt: sortOrder }
          : { createdAt: sortOrder };

    const sortedCampaigns = await prisma.campaign.findMany({
      where: {
        id: { in: pairs.map((p) => p.campaignId) },
        deletedAt: null,
      },
      orderBy,
    });

    const pageSlice = sortedCampaigns.slice(skip, skip + limit);
    const pageIds = pageSlice.map((c) => c.id);
    const rows = await campaignRepository.findManyByIds(pageIds);
    const byId = new Map(rows.map((r) => [r.id, r]));

    const difficulties = await rewardServiceClient.getDifficulties();
    const greenByLevel = new Map(
      difficulties?.map((d) => [d.level, d.greenPoints]),
    );
    const maxByLevel = new Map(
      difficulties?.map((d) => [d.level, d.maxVolunteers]),
    );
    const pageEntities = pageIds
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined);
    const approvedByCampaignId =
      await campaignJoiningRequestRepository.countApprovedByCampaignIds(
        pageEntities.map((e) => e.id),
      );

    const campaignsRaw: CampaignWithAwaitingSubmissionCount[] =
      pageEntities.map((entity) => {
        const base = toCampaignResponse(
          entity,
          greenByLevel.get(entity.difficulty) ?? 0,
          approvedByCampaignId.get(entity.id) ?? 0,
          maxByLevel.get(entity.difficulty) ?? null,
          "en",
        );
        return {
          ...base,
          awaitingSubmissionCount: countById.get(entity.id) ?? 0,
        };
      });

    const campaignsWithVotes = await this.withCampaignVotes(
      campaignsRaw,
      viewerUserId,
    );
    const campaigns = (
      await this.enrichCampaignsForGet(campaignsWithVotes, viewerUserId)
    ).map((c) => ({
      ...c,
      awaitingSubmissionCount: countById.get(c.id) ?? 0,
    }));

    return {
      campaigns,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async updateCampaign(
    id: string,
    userId: string,
    request: UpdateCampaignRequest,
    viewerUserId?: string | null,
  ): Promise<CampaignResponse> {
    const existing = await campaignRepository.findById(id);
    if (!existing) {
      throw new Error("Campaign not found");
    }

    this.ensureOwner(existing.createdBy, userId);

    if (request.difficulty !== undefined) {
      const nextTier = await rewardServiceClient.getDifficultyByLevel(
        request.difficulty,
      );
      if (!nextTier) {
        throw new Error(
          "Invalid campaign difficulty; no matching tier in reward service",
        );
      }
    }

    const shouldUpdateReports = request.reportIds !== undefined;
    const reportIds = shouldUpdateReports
      ? this.normalizeReportIds(request.reportIds)
      : [];
    const shouldUpdateManagers = request.managerIds !== undefined;
    const managerIds = shouldUpdateManagers
      ? this.normalizeManagerIds(
          request.managerIds,
          existing.createdBy ?? userId,
        )
      : [];

    if (shouldUpdateReports) {
      await this.validateReportIds(reportIds);
    }

    const updated = await prisma.$transaction(
      async (tx) => {
        await tx.campaign.update({
          where: { id },
          data: {
            title: request.title,
            ...(request.banner !== undefined ? { banner: request.banner } : {}),
            description: request.description,
            ...(request.startDate !== undefined
              ? {
                  startDate:
                    request.startDate === null
                      ? null
                      : new Date(request.startDate),
                }
              : {}),
            ...(request.endDate !== undefined
              ? {
                  endDate:
                    request.endDate === null ? null : new Date(request.endDate),
                }
              : {}),
            ...(request.detailAddress !== undefined
              ? { detailAddress: request.detailAddress }
              : {}),
            ...(request.latitude !== undefined
              ? { latitude: request.latitude }
              : {}),
            ...(request.longitude !== undefined
              ? { longitude: request.longitude }
              : {}),
            ...(request.radiusKm !== undefined
              ? { radiusKm: request.radiusKm }
              : {}),
            status: request.status,
            ...(request.difficulty !== undefined
              ? { difficulty: request.difficulty }
              : {}),
            updatedBy: userId,
          },
        });

        if (shouldUpdateReports) {
          await tx.report.updateMany({
            where: {
              campaignId: id,
              deletedAt: null,
              status: ReportStatus._STATUS_INPROCESS,
            },
            data: {
              campaignId: null,
              status: ReportStatus._STATUS_TODO,
              updatedBy: userId,
            },
          });
          await tx.report.updateMany({
            where: {
              campaignId: id,
              deletedAt: null,
            },
            data: {
              campaignId: null,
              updatedBy: userId,
            },
          });

          await this.assignReportsToCampaign(tx, id, reportIds);
        }

        if (shouldUpdateManagers) {
          await this.syncManagersForCampaign(tx, id, managerIds, userId);
        }

        const campaign = await tx.campaign.findFirst({
          where: { id, deletedAt: null },
          include: {
            campaignManagers: {
              where: { deletedAt: null },
              select: { userId: true },
            },
            reports: {
              where: { deletedAt: null },
              select: { id: true },
            },
          },
        });

        if (!campaign) {
          throw new Error("Campaign not found");
        }

        return campaign;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );

    return this.toResponseWithVotes(updated, viewerUserId ?? userId);
  }

  /** Admin-only at controller: verify (`ACTIVE`) or ban (`INACTIVE`) a campaign. */
  async adminVerifyCampaign(
    id: string,
    adminUserId: string,
    targetStatus: GlobalStatus._STATUS_ACTIVE | GlobalStatus._STATUS_INACTIVE,
    rejectReason?: string | null,
    viewerUserId?: string | null,
  ): Promise<CampaignResponse> {
    const existing = await campaignRepository.findById(id);
    if (!existing) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"),
      );
    }

    const trimmedReason =
      typeof rejectReason === "string" ? rejectReason.trim() : "";

    if (targetStatus === GlobalStatus._STATUS_ACTIVE) {
      if (existing.status === GlobalStatus._STATUS_ACTIVE) {
        return this.toResponseWithVotes(existing, viewerUserId ?? adminUserId);
      }

      const canApprove =
        existing.status === GlobalStatus._STATUS_PENDING ||
        existing.status === GlobalStatus._STATUS_DRAFT ||
        existing.status === GlobalStatus._STATUS_NEW ||
        existing.status === GlobalStatus._STATUS_INACTIVE;
      if (!canApprove) {
        throw new HttpError(
          HTTP_STATUS.BAD_REQUEST.withMessage(
            "Campaign cannot be approved from its current status",
          ),
        );
      }

      const updated = await campaignRepository.update(id, {
        status: GlobalStatus._STATUS_ACTIVE,
        rejectReason: trimmedReason || null,
        updatedBy: adminUserId,
      });

      void this.notifyNearbyCitizensToJoinApprovedCampaign({
        campaign: updated,
        adminUserId,
      }).catch((err) => {
        console.warn(
          "[campaign] failed to notify nearby citizens to join approved campaign",
          err,
        );
      });

      return this.toResponseWithVotes(updated, viewerUserId ?? adminUserId);
    }

    if (!trimmedReason) {
      throw new HttpError(
        HTTP_STATUS.VALIDATION_ERROR.withMessage(
          "reject_reason is required when banning a campaign",
        ),
      );
    }

    if (existing.status === GlobalStatus._STATUS_INACTIVE) {
      if (existing.rejectReason === trimmedReason) {
        return this.toResponseWithVotes(existing, viewerUserId ?? adminUserId);
      }
      const updated = await campaignRepository.update(id, {
        rejectReason: trimmedReason,
        updatedBy: adminUserId,
      });
      return this.toResponseWithVotes(updated, viewerUserId ?? adminUserId);
    }

    const canBan =
      existing.status === GlobalStatus._STATUS_PENDING ||
      existing.status === GlobalStatus._STATUS_DRAFT ||
      existing.status === GlobalStatus._STATUS_NEW ||
      existing.status === GlobalStatus._STATUS_ACTIVE;
    if (!canBan) {
      throw new HttpError(
        HTTP_STATUS.BAD_REQUEST.withMessage(
          "Campaign cannot be banned from its current status",
        ),
      );
    }

    await this.banCampaignAndUnlinkReports(id, adminUserId, trimmedReason);

    const updated = await campaignRepository.findById(id);
    if (!updated) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"),
      );
    }
    return this.toResponseWithVotes(updated, viewerUserId ?? adminUserId);
  }

  private async banCampaignAndUnlinkReports(
    campaignId: string,
    adminUserId: string,
    rejectReason: string,
  ): Promise<void> {
    await prisma.$transaction(
      async (tx) => {
        await tx.report.updateMany({
          where: {
            campaignId,
            deletedAt: null,
            status: ReportStatus._STATUS_INPROCESS,
          },
          data: {
            campaignId: null,
            status: ReportStatus._STATUS_TODO,
            updatedBy: adminUserId,
          },
        });
        await tx.report.updateMany({
          where: {
            campaignId,
            deletedAt: null,
          },
          data: {
            campaignId: null,
            updatedBy: adminUserId,
          },
        });
        await tx.campaign.update({
          where: { id: campaignId },
          data: {
            status: GlobalStatus._STATUS_INACTIVE,
            rejectReason,
            updatedBy: adminUserId,
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );
  }

  /** Admin-only: approve or reject a pending completion submission. */
  async adminReviewCampaignCompletion(
    id: string,
    adminUserId: string,
    decision: "approve" | "reject",
    rejectReason: string | undefined,
    viewerUserId?: string | null,
  ): Promise<CampaignResponse> {
    if (decision === "approve") {
      return this.adminFinalizeCampaignCompletion(
        id,
        adminUserId,
        viewerUserId,
      );
    }
    return this.adminRejectCampaign(
      id,
      adminUserId,
      rejectReason ?? "",
      viewerUserId,
    );
  }

  /** Admin-only: reject completion submission → in review + notify org owner. */
  async adminRejectCampaign(
    id: string,
    adminUserId: string,
    rejectReason: string,
    viewerUserId?: string | null,
  ): Promise<CampaignResponse> {
    const existing = await campaignRepository.findById(id);
    if (!existing) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"),
      );
    }

    if (existing.status === GlobalStatus._STATUS_WAITING_CONFIRMED) {
      const trimmedReason = rejectReason.trim();
      const updated = await campaignRepository.update(id, {
        status: GlobalStatus._STATUS_ACTIVE,
        rejectReason: trimmedReason,
        updatedBy: adminUserId,
      });

      void this.notifyOrganizationOwnerOfCompletionReview({
        organizationId: existing.organizationId,
        campaignId: id,
        campaign: existing,
        outcome: "rejected",
        rejectReason: trimmedReason,
      }).catch((err) => {
        console.warn(
          "[campaign] failed to notify org owner of completion rejection",
          err,
        );
      });

      return this.toResponseWithVotes(updated, viewerUserId ?? adminUserId);
    }

    throw new HttpError(
      HTTP_STATUS.BAD_REQUEST.withMessage(
        "Reject only applies to a pending completion approval",
      ),
    );
  }

  /**
   * Manager: active campaign (all tasks done) → awaiting final admin approval.
   * `INREVIEW` is accepted only for campaigns already in that legacy status.
   */
  async submitCampaignCompletionForAdminApproval(
    id: string,
    userId: string,
    viewerUserId?: string | null,
  ): Promise<CampaignResponse> {
    const existing = await campaignRepository.findById(id);
    if (!existing) {
      throw new Error("Campaign not found");
    }

    if (existing.status === GlobalStatus._STATUS_WAITING_CONFIRMED) {
      return this.toResponseWithVotes(existing, viewerUserId ?? userId);
    }

    const isManager = await campaignManagerRepository.isManager(id, userId);
    if (!isManager) {
      throw new Error(
        "Only campaign managers can submit completion for admin approval",
      );
    }

    const incompleteTaskCount = await prisma.campaignTask.count({
      where: {
        campaignId: id,
        deletedAt: null,
        status: { not: GlobalStatus._STATUS_COMPLETED },
      },
    });
    if (incompleteTaskCount > 0) {
      throw new Error("Some tasks is not completed");
    }

    const canSubmitFromStatus =
      existing.status === GlobalStatus._STATUS_ACTIVE ||
      existing.status === GlobalStatus._STATUS_INREVIEW;
    if (!canSubmitFromStatus) {
      throw new Error(
        "Campaign must be active before requesting completion approval",
      );
    }

    const updated = await campaignRepository.update(id, {
      status: GlobalStatus._STATUS_WAITING_CONFIRMED,
      updatedBy: userId,
    });

    void this.notifyAdminsCampaignCompletionPendingApproval({
      campaignId: id,
      campaign: existing,
    }).catch((err) => {
      console.warn(
        "[campaign] failed to notify admins of pending campaign completion",
        err,
      );
    });

    void this.notifyNearbyOnCampaignCompletionSubmitted({
      campaign: existing,
      submitterUserId: userId,
    }).catch((err) => {
      console.warn(
        "[campaign] failed to notify nearby citizens for completion verify",
        err,
      );
    });

    return this.toResponseWithVotes(updated, viewerUserId ?? userId);
  }

  private async notifyNearbyOnCampaignCompletionSubmitted(args: {
    campaign: {
      id: string;
      title: string;
      latitude: number | null;
      longitude: number | null;
      createdBy: string | null;
    };
    submitterUserId: string;
  }): Promise<void> {
    const [managerRows, volunteerIds] = await Promise.all([
      campaignManagerRepository.findManagersByCampaignId(args.campaign.id),
      campaignJoiningRequestRepository.findApprovedVolunteerIdsByCampaignId(
        args.campaign.id,
      ),
    ]);
    const excludeUserIds = [
      args.submitterUserId,
      ...(args.campaign.createdBy ? [args.campaign.createdBy] : []),
      ...managerRows.map((m) => m.userId),
      ...volunteerIds,
    ];

    await this.notifyNearbyCitizensForCampaignVerify({
      kind: "CAMPAIGN_COMPLETION_VERIFY_INVITE",
      campaignId: args.campaign.id,
      campaign: args.campaign,
      latitude: args.campaign.latitude,
      longitude: args.campaign.longitude,
      excludeUserIds,
    });
  }

  /** Admin-only: finalize completion (waiting admin confirmation → completed). */
  async adminFinalizeCampaignCompletion(
    id: string,
    userId: string,
    viewerUserId?: string | null,
  ): Promise<CampaignResponse> {
    const existing = await campaignRepository.findById(id);
    if (!existing) {
      throw new Error("Campaign not found");
    }

    if (existing.status === GlobalStatus._STATUS_COMPLETED) {
      return this.toResponseWithVotes(existing, viewerUserId ?? userId);
    }

    if (existing.status !== GlobalStatus._STATUS_WAITING_CONFIRMED) {
      throw new Error(
        "Campaign must await admin completion approval before it can be finalized",
      );
    }

    const incompleteTaskCount = await prisma.campaignTask.count({
      where: {
        campaignId: id,
        deletedAt: null,
        status: { not: GlobalStatus._STATUS_COMPLETED },
      },
    });
    if (incompleteTaskCount > 0) {
      throw new Error("Some tasks is not completed");
    }

    const tier = await rewardServiceClient.getDifficultyByLevel(
      existing.difficulty,
    );
    if (!tier) {
      throw new Error("Campaign difficulty missing in reward service");
    }

    const approvedVolunteerIds =
      await campaignJoiningRequestRepository.findApprovedVolunteerIdsByCampaignId(
        id,
      );
    const checkedInUserIds =
      await campaignAttendanceRepository.findUserIdsByCampaignId(id);
    const checkedInSet = new Set(checkedInUserIds);
    /** Green points: only volunteers who checked in on site (QR). */
    const checkedInVolunteerIds = approvedVolunteerIds.filter((uid) =>
      checkedInSet.has(uid),
    );
    const credits = checkedInVolunteerIds.map((uid) => ({
      userId: uid,
      points: tier.greenPoints,
    }));

    // TODO: re-enable Facebook recognition outbox event.
    // /** Facebook / AI thanks: all approved members (check-in is not required for public recognition). */
    // let recognizedVolunteers: { name: string; email: string | null }[] = [];
    // if (approvedVolunteerIds.length > 0) {
    //   const contacts =
    //     await fetchIdentityUsersWithContactByIds(approvedVolunteerIds);
    //   recognizedVolunteers = approvedVolunteerIds
    //     .map((vid) => {
    //       const u = getIdentityUserContact(contacts, vid);
    //       if (!u?.name?.trim()) return null;
    //       return {
    //         name: u.name.trim(),
    //         email: u.email && u.email.length > 0 ? u.email : null,
    //       };
    //     })
    //     .filter((x): x is { name: string; email: string | null } => x !== null);
    // }
    //
    // const facebookRecognitionPayload: Prisma.InputJsonValue = {
    //   campaignId: id,
    //   campaignTitle: existing.title,
    //   recognizedUserIds: approvedVolunteerIds,
    //   completedAt: new Date().toISOString(),
    //   bannerUrl: existing.banner ?? null,
    //   description: existing.description ?? null,
    //   ...(recognizedVolunteers.length > 0 ? { recognizedVolunteers } : {}),
    // };

    // Complete campaign + emit reward events atomically. The outbox relay
    // delivers them to reward-service, so completion is never half-applied and
    // there is no post-commit enqueue/rollback dance.
    await prisma.$transaction(
      async (tx) => {
        await tx.campaign.update({
          where: { id },
          data: {
            status: GlobalStatus._STATUS_COMPLETED,
            rejectReason: null,
            updatedBy: userId,
          },
        });
        await tx.report.updateMany({
          where: { campaignId: id, deletedAt: null },
          data: {
            status: ReportStatus._STATUS_COMPLETED,
            updatedBy: userId,
          },
        });
        await tx.sos.updateMany({
          where: {
            campaignId: id,
            deletedAt: null,
            status: { not: GlobalStatus._STATUS_COMPLETED },
          },
          data: {
            status: GlobalStatus._STATUS_COMPLETED,
            updatedBy: userId,
          },
        });

        if (credits.length > 0) {
          await emitOutbox(tx, {
            aggregateType: "campaign",
            aggregateId: id,
            eventType: OutboxEventType.CAMPAIGN_COMPLETION_GREEN_POINTS,
            payload: { campaignId: id, credits },
            dedupKey: `${OutboxEventType.CAMPAIGN_COMPLETION_GREEN_POINTS}:${id}`,
          });
        }
        // TODO: re-enable Facebook recognition outbox event.
        // await emitOutbox(tx, {
        //   aggregateType: "campaign",
        //   aggregateId: id,
        //   eventType: OutboxEventType.CAMPAIGN_FACEBOOK_RECOGNITION,
        //   payload: facebookRecognitionPayload,
        //   dedupKey: `${OutboxEventType.CAMPAIGN_FACEBOOK_RECOGNITION}:${id}`,
        // });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );

    void this.notifyApprovedVolunteersCampaignDone({
      volunteerIds: approvedVolunteerIds,
      campaignId: id,
      campaign: existing,
    }).catch((err) => {
      console.warn(
        "[campaign] failed to notify volunteers of campaign completion",
        err,
      );
    });

    void this.notifyOrganizationOwnerOfCompletionReview({
      organizationId: existing.organizationId,
      campaignId: id,
      campaign: existing,
      outcome: "approved",
    }).catch((err) => {
      console.warn(
        "[campaign] failed to notify org owner of completion approval",
        err,
      );
    });

    const updated = await campaignRepository.findById(id);
    if (!updated) {
      throw new Error("Campaign not found");
    }
    return this.toResponseWithVotes(updated, viewerUserId ?? userId);
  }

  private async notifyApprovedVolunteersCampaignDone(args: {
    volunteerIds: string[];
    campaignId: string;
    campaign: {
      title: string;
      titleVi?: string | null;
      titleEn?: string | null;
    };
  }): Promise<void> {
    if (args.volunteerIds.length === 0) {
      return;
    }
    await enqueueWebsiteNotificationsToUsers({
      kind: "CAMPAIGN_DONE",
      userIds: args.volunteerIds,
      payload: {
        campaignId: args.campaignId,
        ...campaignNameNotificationPayload(args.campaign),
      },
    });
  }

  private async notifyAdminsCampaignCompletionPendingApproval(args: {
    campaignId: string;
    campaign: {
      title: string;
      titleVi?: string | null;
      titleEn?: string | null;
    };
  }): Promise<void> {
    const adminIds = getCampaignCompletionAdminNotifyUserIds();
    if (adminIds.length === 0) {
      console.warn(
        "[campaign] CAMPAIGN_COMPLETION_ADMIN_NOTIFY_USER_IDS empty; skipping admin completion-pending notifications",
        { campaignId: args.campaignId },
      );
      return;
    }
    const titlePayload = campaignTitleNotificationPayload(args.campaign);
    await Promise.all(
      adminIds.map((userId) =>
        enqueueCampaignCompletionPendingAdminWebsiteNotification({
          userId,
          campaignId: args.campaignId,
          campaignTitle: titlePayload.campaignTitle,
        }),
      ),
    );
  }

  private async resolveOrganizationOwnerIds(
    organizationId: string,
  ): Promise<string[]> {
    return organizationMemberRepository.findOwnerUserIds(organizationId);
  }

  private async notifyOrganizationOwnerOfCompletionReview(args: {
    organizationId: string;
    campaignId: string;
    campaign: {
      title: string;
      titleVi?: string | null;
      titleEn?: string | null;
    };
    outcome: "approved" | "rejected";
    rejectReason?: string;
  }): Promise<void> {
    const ownerIds = await this.resolveOrganizationOwnerIds(args.organizationId);
    if (ownerIds.length === 0) {
      return;
    }

    const titlePayload = campaignTitleNotificationPayload(args.campaign);
    if (args.outcome === "approved") {
      await enqueueWebsiteNotificationsToUsers({
        kind: "CAMPAIGN_COMPLETION_APPROVED_BY_ADMIN",
        userIds: ownerIds,
        payload: {
          campaignId: args.campaignId,
          ...titlePayload,
        },
      });
      return;
    }

    await enqueueWebsiteNotificationsToUsers({
      kind: "CAMPAIGN_COMPLETION_REJECTED_BY_ADMIN",
      userIds: ownerIds,
      payload: {
        campaignId: args.campaignId,
        rejectReason: args.rejectReason ?? "",
        ...titlePayload,
      },
    });
  }

  async deleteCampaign(id: string, userId: string): Promise<void> {
    const existing = await campaignRepository.findById(id);
    if (!existing) {
      throw new Error("Campaign not found");
    }

    this.ensureOwner(existing.createdBy, userId);

    await prisma.$transaction(
      async (tx) => {
        await tx.report.updateMany({
          where: {
            campaignId: id,
            deletedAt: null,
            status: ReportStatus._STATUS_INPROCESS,
          },
          data: {
            campaignId: null,
            status: ReportStatus._STATUS_TODO,
            updatedBy: userId,
          },
        });
        await tx.report.updateMany({
          where: {
            campaignId: id,
            deletedAt: null,
          },
          data: {
            campaignId: null,
            updatedBy: userId,
          },
        });

        await tx.campaign.update({
          where: { id },
          data: {
            deletedAt: new Date(),
            updatedBy: userId,
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );
  }

  private ensureOwner(ownerId: string | null, userId: string): void {
    if (!ownerId || ownerId !== userId) {
      throw new Error(
        HTTP_STATUS.FORBIDDEN.withMessage(
          "Only campaign manager can modify campaign",
        ).message,
      );
    }
  }

  private normalizeReportIds(reportIds?: string[]): string[] {
    if (!reportIds || reportIds.length === 0) {
      return [];
    }

    return [
      ...new Set(
        reportIds.map((id) => id.trim()).filter((id) => id.length > 0),
      ),
    ];
  }

  private normalizeManagerIds(
    managerIds: string[] | undefined,
    ownerId: string,
  ): string[] {
    const normalized = (managerIds ?? [])
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    // Owner is always the first manager.
    return [...new Set([ownerId, ...normalized])];
  }

  private async validateReportIds(reportIds: string[]): Promise<void> {
    if (reportIds.length === 0) {
      return;
    }

    const validIds = await campaignRepository.findValidReportIds(reportIds);
    if (validIds.length !== reportIds.length) {
      throw new Error("One or more reportIds are invalid");
    }
  }

  private async assignReportsToCampaign(
    tx: Prisma.TransactionClient,
    campaignId: string,
    reportIds: string[],
  ): Promise<void> {
    if (reportIds.length === 0) {
      return;
    }

    const result = await tx.report.updateMany({
      where: {
        id: { in: reportIds },
        deletedAt: null,
        campaignId: null,
        status: ReportStatus._STATUS_TODO,
      },
      data: {
        campaignId,
        status: ReportStatus._STATUS_INPROCESS,
      },
    });

    if (result.count !== reportIds.length) {
      throw new Error(
        "Some reports could not be linked to campaign (must be admin-approved, not in another campaign, or were modified concurrently)",
      );
    }
  }

  private async assignManagersToCampaign(
    tx: Prisma.TransactionClient,
    campaignId: string,
    managerIds: string[],
    assignedBy: string,
  ): Promise<void> {
    for (const managerId of managerIds) {
      await tx.campaignManager.upsert({
        where: {
          campaignId_userId: {
            campaignId,
            userId: managerId,
          },
        },
        create: {
          campaignId,
          userId: managerId,
          assignedBy,
          createdBy: assignedBy,
          updatedBy: assignedBy,
        },
        update: {
          deletedAt: null,
          assignedBy,
          updatedBy: assignedBy,
        },
      });
    }
  }

  private async syncManagersForCampaign(
    tx: Prisma.TransactionClient,
    campaignId: string,
    managerIds: string[],
    assignedBy: string,
  ): Promise<void> {
    await tx.campaignManager.updateMany({
      where: {
        campaignId,
        deletedAt: null,
        userId: { notIn: managerIds },
      },
      data: {
        deletedAt: new Date(),
        updatedBy: assignedBy,
      },
    });

    await this.assignManagersToCampaign(tx, campaignId, managerIds, assignedBy);
  }
}

export const campaignService = new CampaignService();
