import { Prisma } from "@prisma/client";
import prisma from "../../config/prisma.client";
import {
  GlobalStatus,
  JoinRequestStatus,
  ReportStatus,
  SavedResourceType,
  VoteResourceType,
} from "../../constants/status.enum";
import { HttpError, HTTP_STATUS } from "../../constants/http-status";
import { organizationRepository } from "../organization/organization.repository";
import { rewardServiceClient } from "../reward/reward-service.client";
import { campaignJoiningRequestRepository } from "./campaign_joining_request/campaign_joining_request.repository";
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
import { savedResourceRepository } from "../saved_resource/saved_resource.repository";
import { defaultResourceVoteSummary } from "../vote/vote.dto";
import { voteService } from "../vote/vote.service";
import {
  fetchOrganizationOwnersByUserIds,
  getUserProfile,
} from "../organization/identity-user.client";
import type { OrganizationOwnerResponse } from "../organization/organization.dto";
import { toReportResponse } from "../report/report.entity";
import type { ReportResponse } from "../report/report.dto";
import { reportService } from "../report/report.service";

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

    const orgOwnerIds = [
      ...new Set(organizations.map((o) => o.ownerId).filter(Boolean)),
    ];
    const identityUserIds = [...new Set([...managerIds, ...orgOwnerIds])];
    const profileMap = await fetchOrganizationOwnersByUserIds(identityUserIds);

    const organizationMap = new Map(
      organizations.map((org) => [
        org.id,
        {
          background_url: org.backgroundUrl,
          contact_email: org.contactEmail,
          logo_url: org.logoUrl,
          name: org.name,
          ownerId: org.ownerId,
        },
      ]),
    );

    return campaigns.map((campaign) => {
      const orgRow = organizationMap.get(campaign.organizationId);
      const orgOwner = orgRow
        ? (getUserProfile(profileMap, orgRow.ownerId) ??
          this.ownerFallback(orgRow.ownerId))
        : null;
      const organization = orgRow
        ? {
            background_url: orgRow.background_url,
            contact_email: orgRow.contact_email,
            logo_url: orgRow.logo_url,
            name: orgRow.name,
          }
        : undefined;

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
    return toCampaignResponse(entity, greenPoints, currentMembers, maxMembers);
  }

  private async withCampaignVotes(
    campaigns: CampaignResponse[],
    viewerUserId?: string | null,
  ): Promise<CampaignResponse[]> {
    if (campaigns.length === 0) {
      return campaigns;
    }
    const ids = campaigns.map((c) => c.id);
    const [map, savedIds] = await Promise.all([
      voteService.getVoteSummariesForResources(
        VoteResourceType.CAMPAIGN,
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
      saved: viewerUserId != null ? savedIds.has(c.id) : null,
    }));
  }

  private async toResponseWithVotes(
    entity: CampaignWithReports,
    viewerUserId?: string | null,
  ): Promise<CampaignResponse> {
    const base = await this.toResponse(entity);
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
    if (org.ownerId !== userId) {
      throw new HttpError(
        HTTP_STATUS.FORBIDDEN.withMessage(
          "Only the organization owner can create campaigns",
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

    const created = await prisma.$transaction(
      async (tx) => {
        // Prisma Client types may lag behind the schema in dev environments.
        // Keep runtime payload correct, and avoid excess-property TS errors.
        const createData = ({
          title: request.title,
          banner: request.banner,
          description: request.description,
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
        } as unknown) as Prisma.CampaignUncheckedCreateInput;

        const campaign = await tx.campaign.create({
          data: createData,
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

    return this.toResponseWithVotes(created, viewerUserId ?? userId);
  }

  async getCampaignById(
    id: string,
    viewerUserId?: string | null,
  ): Promise<CampaignResponse | null> {
    const campaign = await campaignRepository.findById(id);
    if (!campaign) return null;
    const baseRaw = await this.toResponseWithVotes(campaign, viewerUserId);
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
    const list = resolved.map((campaign) =>
      toCampaignResponse(
        campaign,
        greenByLevel.get(campaign.difficulty) ?? 0,
        approvedByCampaignId.get(campaign.id) ?? 0,
        maxByLevel.get(campaign.difficulty) ?? null,
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
    return {
      campaigns: campaignsWithRequestStatus,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
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

  /** Admin-only at controller: approve campaign (active). */
  async adminVerifyCampaign(
    id: string,
    adminUserId: string,
    viewerUserId?: string | null,
  ): Promise<CampaignResponse> {
    const existing = await campaignRepository.findById(id);
    if (!existing) {
      throw new Error("Campaign not found");
    }

    if (existing.status === GlobalStatus._STATUS_ACTIVE) {
      return this.toResponseWithVotes(existing, viewerUserId ?? adminUserId);
    }

    const updated = await campaignRepository.update(id, {
      status: GlobalStatus._STATUS_ACTIVE,
      updatedBy: adminUserId,
    });
    return this.toResponseWithVotes(updated, viewerUserId ?? adminUserId);
  }

  /** Admin-only: reject draft campaign — inactive and unlink in-progress reports back to pending. */
  async adminRejectCampaign(
    id: string,
    adminUserId: string,
    viewerUserId?: string | null,
  ): Promise<CampaignResponse> {
    const existing = await campaignRepository.findById(id);
    if (!existing) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"),
      );
    }

    if (existing.status === GlobalStatus._STATUS_INACTIVE) {
      return this.toResponseWithVotes(existing, viewerUserId ?? adminUserId);
    }

    if (
      existing.status === GlobalStatus._STATUS_ACTIVE ||
      existing.status === GlobalStatus._STATUS_COMPLETED
    ) {
      throw new HttpError(
        HTTP_STATUS.BAD_REQUEST.withMessage(
          "Cannot reject a campaign that is already active or completed",
        ),
      );
    }

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
            updatedBy: adminUserId,
          },
        });
        await tx.report.updateMany({
          where: {
            campaignId: id,
            deletedAt: null,
          },
          data: {
            campaignId: null,
            updatedBy: adminUserId,
          },
        });
        await tx.campaign.update({
          where: { id },
          data: {
            status: GlobalStatus._STATUS_INACTIVE,
            updatedBy: adminUserId,
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );

    const updated = await campaignRepository.findById(id);
    if (!updated) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"),
      );
    }
    return this.toResponseWithVotes(updated, viewerUserId ?? adminUserId);
  }

  /** Admin-only: mark campaign completed and queue green points for approved volunteers. */
  async markCampaignDone(
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

    if (existing.status !== GlobalStatus._STATUS_ACTIVE) {
      throw new Error(
        "Campaign must be active (admin-approved) before it can be marked done",
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

    const volunteerIds =
      await campaignJoiningRequestRepository.findApprovedVolunteerIdsByCampaignId(
        id,
      );
    const credits = volunteerIds.map((userId) => ({
      userId,
      points: tier.greenPoints,
    }));

    await prisma.$transaction(
      async (tx) => {
        await tx.campaign.update({
          where: { id },
          data: {
            status: GlobalStatus._STATUS_COMPLETED,
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
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );

    if (credits.length > 0) {
      try {
        await rewardServiceClient.enqueueCampaignCompletionGreenPoints({
          campaignId: id,
          credits,
        });
      } catch (e) {
        await prisma.$transaction(
          async (tx) => {
            await tx.campaign.update({
              where: { id },
              data: {
                status: GlobalStatus._STATUS_ACTIVE,
                updatedBy: userId,
              },
            });
            await tx.report.updateMany({
              where: {
                campaignId: id,
                deletedAt: null,
                status: ReportStatus._STATUS_COMPLETED,
              },
              data: {
                status: ReportStatus._STATUS_INPROCESS,
                updatedBy: userId,
              },
            });
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          },
        );
        throw e;
      }
    }

    const updated = await campaignRepository.findById(id);
    if (!updated) {
      throw new Error("Campaign not found");
    }
    return this.toResponseWithVotes(updated, viewerUserId ?? userId);
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
