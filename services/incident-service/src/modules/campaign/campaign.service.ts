import { Prisma } from "@prisma/client";
import { isOwnerRole, type AppLocale } from "@da2/constants";
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
import { getCampaignAdminNotifyUserIds } from "./campaign-completion-admin-notify.config";
import { campaignManagerRepository } from "./campaign_manager/campaign_manager.repository";
import { rewardServiceClient } from "../reward/reward-service.client";
import { campaignRegistrationRepository } from "./campaign_registration/campaign_registration.repository";
import { shiftAttendanceService } from "./campaign_attendance/shift-attendance.service";
import { campaignRepository } from "./campaign.repository";
import { campaignAccessService } from "./campaign-access.service";
import { TeamCampaign, assertLeadersInTeam } from "./campaign_manager/campaign-team";
import { applyPostApprovalEdit, isPostApprovalEdit } from "./campaign-post-approval-edit";
import { campaignManagerService } from "./campaign_manager/campaign_manager.service";
import {
  CAMPAIGN_DELETABLE_STATUSES,
  CAMPAIGN_DIFFICULTY_MAX,
  CAMPAIGN_DIFFICULTY_MIN,
  CAMPAIGN_PUBLIC_STATUSES,
  CampaignStatus,
} from "@da2/constants";
import { campaignEligibilityService } from "./campaign-eligibility.service";
import {
  campaignLifecycleService,
  diffSnapshots,
  isCancellable,
  isPreApproval,
  scheduleFromRequest,
  scheduleOf,
  type NormalizedSchedule,
} from "./campaign-lifecycle.service";
import { logCampaignEdit, transitionCampaign } from "./campaign-state-machine";
import { isPlatformAdmin } from "./campaign-access.service";
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
  getUserProfile,
} from "../organization/identity-user.client";
import type { OrganizationOwnerResponse } from "../organization/organization.dto";
import { toReportResponse } from "../report/report.entity";
import type { ReportResponse } from "../report/report.dto";
import { reportService } from "../report/report.service";
import { findNearbyUserIds } from "./nearby-users";
import { emitOutbox } from "../../outbox/outbox.writer";
import { OutboxEventType } from "../../outbox/outbox.types";

function assertDifficultyInRange(level: number): void {
  if (
    !Number.isInteger(level) ||
    level < CAMPAIGN_DIFFICULTY_MIN ||
    level > CAMPAIGN_DIFFICULTY_MAX
  ) {
    throw new HttpError(
      HTTP_STATUS.VALIDATION_ERROR.withMessage(
        `difficulty must be between ${CAMPAIGN_DIFFICULTY_MIN} and ${CAMPAIGN_DIFFICULTY_MAX}`,
      ),
    );
  }
}

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
    difficulties: {
      level: number;
      greenPoints: number;
      maxVolunteers: number | null;
      suggestedMinVolunteers: number | null;
    }[];
  }> {
    const unique = [...new Set(levels)].filter((l) => Number.isFinite(l));
    const difficulties = await rewardServiceClient.getDifficulties();
    if (difficulties.length > 0) {
      return {
        greenByLevel: new Map(difficulties.map((d) => [d.level, d.greenPoints])),
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

    const [organizations, reportsByCampaignId, accessByCampaignId] = await Promise.all([
      organizationRepository.findManyByIds(organizationIds).catch(() => []),
      this.getReportsByCampaignIds(campaignIds, viewerUserId),
      campaignAccessService.resolveMany(
        campaigns.map((c) => ({
          id: c.id,
          organizationId: c.organizationId,
          createdBy: c.createdBy ?? null,
          managerIds: c.managers.map((m) => m.id),
        })),
        viewerUserId,
      ),
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

      const access = accessByCampaignId.get(campaign.id);
      const canManageCampaign = access?.canManage ?? false;
      const canDeleteCampaign = access?.canDelete ?? false;
      const canCancelCampaign = canDeleteCampaign && isCancellable(campaign);

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
        ...(viewerUserId != null ? { canManageCampaign, canDeleteCampaign, canCancelCampaign } : {}),
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

    // Locked reports carry `campaignId`; a draft's picks are only linked to its meeting points.
    const links = await prisma.campaignMeetingPointReport.findMany({
      where: { campaignId: { in: campaignIds } },
      select: { campaignId: true, reportId: true },
    });
    const linkedCampaignIdsByReport = new Map<string, Set<string>>();
    for (const link of links) {
      const set = linkedCampaignIdsByReport.get(link.reportId) ?? new Set<string>();
      set.add(link.campaignId);
      linkedCampaignIdsByReport.set(link.reportId, set);
    }
    const rows = await prisma.report.findMany({
      where: {
        deletedAt: null,
        OR: [
          { campaignId: { in: campaignIds } },
          ...(links.length > 0
            ? [{ id: { in: [...linkedCampaignIdsByReport.keys()] } }]
            : []),
        ],
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
    const wanted = new Set(campaignIds);
    for (const row of rows) {
      const mapped = byId.get(row.id);
      if (!mapped) continue;
      const owners = new Set(linkedCampaignIdsByReport.get(row.id) ?? []);
      if (row.campaignId && wanted.has(row.campaignId)) owners.add(row.campaignId);
      for (const campaignId of owners) {
        const list = out.get(campaignId);
        if (!list) {
          out.set(campaignId, [mapped]);
        } else {
          list.push(mapped);
        }
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
      campaignRegistrationRepository
        .countVolunteersByCampaignIds([entity.id])
        .then((m) => m.get(entity.id) ?? 0),
    ]);
    if (!tier) {
      this.debugWarn("missing reward tier for campaign difficulty", {
        campaignId: entity.id,
        difficulty: entity.difficulty,
      });
    }
    const greenPoints = tier?.greenPoints ?? 0;
    // Registration is never capped (spec 3.1); shifts carry their own min / expected max.
    return toCampaignResponse(
      entity,
      greenPoints,
      currentMembers,
      null,
      locale,
      tier?.suggestedMinVolunteers ?? null,
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

  /** `requestStatus` APPROVED on the campaigns the viewer holds a shift in (kept for older clients). */
  private async withCampaignListRequestStatus(
    campaigns: CampaignResponse[],
    viewerUserId: string,
  ): Promise<CampaignResponse[]> {
    if (campaigns.length === 0) {
      return campaigns;
    }
    const registered = await campaignRegistrationRepository.findRegisteredCampaignIds(
      viewerUserId,
      campaigns.map((c) => c.id),
    );
    return campaigns.map((campaign) =>
      registered.has(campaign.id)
        ? { ...campaign, requestStatus: JoinRequestStatus._STATUS_APPROVED }
        : campaign,
    );
  }

  /**
   * Creates a DRAFT (spec 1.5). Nothing is locked yet: the chosen reports are only remembered
   * on the meeting points, and the full rules run when the draft is sent for review.
   */
  /**
   * Waste points of a schedule must be selectable, and shift leaders must be on the campaign's
   * team (spec 3.4). Leaders of off shifts count too: they come back when the shift is turned on.
   */
  private async assertScheduleUsable(
    schedule: NormalizedSchedule,
    team: TeamCampaign,
  ): Promise<void> {
    const campaignId = team.id ?? null;
    await campaignLifecycleService.assertReportsSelectable(
      prisma,
      campaignId,
      schedule.meetingPoints.flatMap((p) => p.reportIds),
    );
    const leaderIds = [
      ...new Set(
        schedule.shifts.map((sh) => sh.leaderUserId).filter((x): x is string => !!x),
      ),
    ];
    await assertLeadersInTeam(prisma, team, leaderIds);
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
    await campaignEligibilityService.assertCanCreateDraft(userId, org.id);

    // A draft only needs a level in range; the tier (volunteer cap) is checked on submit, so
    // saving a draft does not depend on reward-service.
    assertDifficultyInRange(request.difficulty);

    const schedule: NormalizedSchedule = scheduleFromRequest(request, null, userId) ?? {
      days: [],
      meetingPoints: [],
      shifts: [],
    };
    await this.assertScheduleUsable(schedule, { organizationId: org.id, createdBy: userId });

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
            difficulty: request.difficulty,
            contactName: request.contactName?.trim() || null,
            contactPhone: request.contactPhone?.trim() || null,
            safetyNotes: request.safetyNotes?.trim() || null,
            minVolunteersReason: request.minVolunteersReason?.trim() || null,
            ...(request.requirements != null
              ? { requirements: request.requirements as Prisma.InputJsonValue }
              : {}),
            status: CampaignStatus.DRAFT,
            organizationId: request.organizationId,
            createdBy: userId,
            updatedBy: userId,
          },
        });

        // The creator manages the draft right away, so co-managers can see it too.
        await this.assignManagersToCampaign(tx, campaign.id, [userId], userId);
        await campaignLifecycleService.replaceSchedule(tx, campaign.id, schedule, userId);

        return campaignLifecycleService.loadInTx(tx, campaign.id);
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );

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

    return this.toResponseWithVotes(created, viewerUserId ?? userId);
  }

  /** Sends a draft (or a campaign waiting for changes) for admin review. */
  async submitCampaign(
    id: string,
    userId: string,
  ): Promise<CampaignResponse> {
    const campaign = await campaignLifecycleService.submit(id, userId);
    return this.getCampaignById(campaign.id, userId, null, null) as Promise<CampaignResponse>;
  }

  /** Admin decision on a campaign waiting for review. */
  async reviewCampaign(
    id: string,
    adminUserId: string,
    decision: "approve" | "request_revision" | "block",
    reason: string | null | undefined,
  ): Promise<CampaignResponse> {
    const approvedBefore = (await prisma.campaign.findUnique({
      where: { id },
      select: { approvedAt: true },
    }))?.approvedAt;
    const campaign = await campaignLifecycleService.review(
      id,
      adminUserId,
      decision,
      reason,
    );
    // Residents nearby were invited the first time; approving an edit does not invite again.
    if (decision === "approve" && !approvedBefore) {
      void this.notifyNearbyCitizensToJoinApprovedCampaign({
        campaign,
        adminUserId,
      }).catch((err) => {
        console.warn(
          "[campaign] failed to notify nearby citizens to join approved campaign",
          err,
        );
      });
    }
    return this.toResponseWithVotes(campaign, adminUserId);
  }

  /**
   * Notifies citizens near the campaign point: users with a saved location (identity-service)
   * and/or users who filed geolocated reports in the area (`findNearbyUserIds`).
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

    const recipientIds = await findNearbyUserIds(
      [{ latitude: args.latitude, longitude: args.longitude }],
      args.excludeUserIds,
    );

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

  /**
   * Drafts are visible only to the people who manage them; campaigns under review, blocked or
   * expired also to admins; everyone else gets null (404). The contact phone is shown to
   * managers, admins and accepted volunteers.
   */
  async getCampaignById(
    id: string,
    viewerUserId?: string | null,
    locale?: AppLocale | null,
    viewerRole?: string | null,
  ): Promise<CampaignResponse | null> {
    const campaign = await campaignRepository.findById(id);
    if (!campaign) return null;
    const isAdmin = isPlatformAdmin(viewerRole);
    const canManage = viewerUserId
      ? (await campaignAccessService.resolve(campaign, viewerUserId)).canManage
      : false;
    // A draft is private to the people managing it, admins included out.
    if (campaign.status === CampaignStatus.DRAFT && !canManage) {
      return null;
    }
    // Back under review after an edit (spec 3.5): the volunteers who kept their place still see it.
    const keptVolunteer =
      !isAdmin &&
      !canManage &&
      !!viewerUserId &&
      campaign.approvedAt != null &&
      !CAMPAIGN_PUBLIC_STATUSES.includes(campaign.status) &&
      (await campaignRegistrationRepository.isRegistered(campaign.id, viewerUserId));
    if (
      !isAdmin &&
      !canManage &&
      !keptVolunteer &&
      !CAMPAIGN_PUBLIC_STATUSES.includes(campaign.status)
    ) {
      return null;
    }

    const baseRaw = await this.toResponseWithVotes(
      campaign,
      viewerUserId,
      locale,
    );
    const [enriched] = await this.enrichCampaignsForGet([baseRaw], viewerUserId);
    const [byShift, myShiftIds] = await Promise.all([
      campaignRegistrationRepository.countByShift(id),
      viewerUserId
        ? campaignRegistrationRepository.findMyShiftIds(id, viewerUserId)
        : Promise.resolve([] as string[]),
    ]);
    const counted = {
      ...enriched,
      shifts: enriched.shifts?.map((sh) => ({
        ...sh,
        registeredCount: byShift.get(sh.id) ?? 0,
      })),
    };
    if (!viewerUserId) {
      return counted;
    }
    const isRegistered = myShiftIds.length > 0;
    const base =
      isAdmin || canManage || isRegistered
        ? { ...counted, contactPhone: campaign.contactPhone ?? null }
        : counted;
    return isRegistered
      ? { ...base, myShiftIds, requestStatus: JoinRequestStatus._STATUS_APPROVED }
      : { ...base, myShiftIds };
  }

  /**
   * campaignIds limited to 100 UUIDs at the controller. Same visibility as GET /:id: campaigns
   * that are not public are left out unless the viewer manages them (or, drafts aside, is an
   * admin).
   */
  async getCampaignsByIds(
    campaignIds: string[],
    viewerUserId?: string | null,
    locale?: AppLocale | null,
    viewerRole?: string | null,
  ): Promise<CampaignResponse[]> {
    if (campaignIds.length === 0) {
      return [];
    }
    const rows = await campaignRepository.findManyByIds(campaignIds);
    const isAdmin = isPlatformAdmin(viewerRole);
    const access = await campaignAccessService.resolveMany(
      rows.map((c) => ({
        id: c.id,
        organizationId: c.organizationId,
        createdBy: c.createdBy,
        managerIds: c.campaignManagers.map((m) => m.userId),
      })),
      viewerUserId,
    );
    const visible = rows.filter((c) => {
      const canManage = access.get(c.id)?.canManage ?? false;
      if (c.status === CampaignStatus.DRAFT) return canManage;
      return canManage || isAdmin || CAMPAIGN_PUBLIC_STATUSES.includes(c.status);
    });
    const byId = new Map(visible.map((row) => [row.id, row]));
    const resolved = campaignIds
      .map((id) => byId.get(id))
      .filter((row): row is CampaignWithReports => row !== undefined);

    const { greenByLevel } = await this.resolveTierMaps(
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
      await campaignRegistrationRepository.countVolunteersByCampaignIds(
        resolved.map((c) => c.id),
      );
    const loc = locale ?? "en";
    const list = resolved.map((campaign) =>
      toCampaignResponse(
        campaign,
        greenByLevel.get(campaign.difficulty) ?? 0,
        approvedByCampaignId.get(campaign.id) ?? 0,
        null,
        loc,
      ),
    );
    const withVotes = await this.withCampaignVotes(list, viewerUserId);
    return this.enrichCampaignsForGet(withVotes, viewerUserId);
  }

  /**
   * GET /campaigns. The public list leaves out the viewer's own campaigns (created, managed or
   * registered for; those live under /campaigns/my). Platform admins (`publicOnly: false`) see
   * every campaign, theirs included. Owners and legal representatives listing their own
   * organization see all of its campaigns in every status, the scope of /campaigns/my?is_owner=true.
   */
  async listCampaigns(query: CampaignListQuery, userId?: string) {
    const ownerView =
      !!userId &&
      !!query.organizationId &&
      (await this.isOrganizationOwner(query.organizationId, userId));
    if (!ownerView) {
      return this.getCampaigns(query, userId, undefined, query.publicOnly ? userId : undefined);
    }
    return this.getCampaigns(
      { ...query, publicOnly: false, excludeDrafts: false, isOwner: true },
      userId,
      userId,
    );
  }

  /** Whether the user is an active owner (owner / legal representative) of the organization. */
  async isOrganizationOwner(organizationId: string, userId: string): Promise<boolean> {
    return isOwnerRole(
      await organizationMemberRepository.findActiveRole(organizationId, userId),
    );
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

    const { difficulties, greenByLevel } =
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
        excludeMemberOrgsOfUserId: query.excludeMemberOrgsOfUserId,
        publicOnly: query.publicOnly,
        excludeDrafts: query.excludeDrafts,
      },
      skip,
      take: limit,
      sortBy,
      sortOrder,
    });

    const approvedByCampaignId =
      await campaignRegistrationRepository.countVolunteersByCampaignIds(
        rows.map((c) => c.id),
      );

    // If the global list wasn't available, resolve only the levels we need for this page.
    const tierMaps =
      difficulties.length > 0
        ? { greenByLevel }
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
        null,
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
      await campaignRegistrationRepository.countVolunteersByCampaignIds(
        rows.map((c) => c.id),
      );

    const tierMaps = await this.resolveTierMaps(rows.map((r) => r.difficulty));

    const campaigns = rows.map((campaign) =>
      toCampaignResponse(
        campaign,
        tierMaps.greenByLevel.get(campaign.difficulty) ?? 0,
        approvedByCampaignId.get(campaign.id) ?? 0,
        null,
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
    const pageEntities = pageIds
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined);
    const approvedByCampaignId =
      await campaignRegistrationRepository.countVolunteersByCampaignIds(
        pageEntities.map((e) => e.id),
      );

    const campaignsRaw: CampaignWithAwaitingSubmissionCount[] =
      pageEntities.map((entity) => {
        const base = toCampaignResponse(
          entity,
          greenByLevel.get(entity.difficulty) ?? 0,
          approvedByCampaignId.get(entity.id) ?? 0,
          null,
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

  /**
   * Before approval (draft, under review, needs revision) every field may change; under review
   * each edit is logged for the admin and report locks follow the meeting points at once.
   * Once approved, edits go by id through `applyPostApprovalEdit` until the campaign starts (3.5).
   * The status never changes here — only through the lifecycle endpoints.
   */
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

    await campaignAccessService.assertCanManage(existing, userId);

    // Spec 3.5: an approved campaign is edited in place, by id, until it starts.
    if (isPostApprovalEdit(existing)) {
      if (request.difficulty !== undefined) {
        assertDifficultyInRange(request.difficulty);
      }
      if (request.managerIds !== undefined) {
        throw new HttpError(HTTP_STATUS.CAMPAIGN_NOT_EDITABLE, { fields: ["managerIds"] });
      }
      const { reReview } = await applyPostApprovalEdit(existing, userId, request);
      const fresh = await campaignRepository.findById(id);
      if (!fresh) throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"));
      return { ...(await this.toResponseWithVotes(fresh, viewerUserId ?? userId)), reReview };
    }
    // Running or over: nothing changes through editing any more.
    if (!isPreApproval(existing.status)) {
      throw new HttpError(HTTP_STATUS.CAMPAIGN_NOT_EDITABLE);
    }

    if (request.difficulty !== undefined) {
      assertDifficultyInRange(request.difficulty);
    }

    const schedule = scheduleFromRequest(
      request,
      scheduleOf(existing),
      existing.createdBy ?? userId,
    );
    const shouldUpdateManagers = request.managerIds !== undefined;
    const managerIds = shouldUpdateManagers
      ? this.normalizeManagerIds(
          request.managerIds,
          existing.createdBy ?? userId,
        )
      : [];
    if (shouldUpdateManagers) {
      await campaignManagerService.assertAllMembers(existing.organizationId, managerIds);
    }
    const team: TeamCampaign = {
      id,
      organizationId: existing.organizationId,
      createdBy: existing.createdBy,
      ...(shouldUpdateManagers ? { managerIds } : {}),
    };
    if (schedule) {
      await this.assertScheduleUsable(schedule, team);
    } else if (shouldUpdateManagers) {
      // Managers dropped from the list must not be leading shifts still to come.
      const dropped = existing.campaignManagers
        .map((m) => m.userId)
        .filter((uid) => !managerIds.includes(uid));
      await campaignManagerService.assertLeadsNoShifts(existing, dropped);
    }

    const optionalText = (value: string | null | undefined) =>
      value === undefined ? undefined : value?.trim() || null;

    const updated = await prisma.$transaction(
      async (tx) => {
        const before = await campaignLifecycleService.loadInTx(tx, id);
        if (before.status !== existing.status) {
          throw new HttpError(
            HTTP_STATUS.CAMPAIGN_INVALID_TRANSITION.withMessage(
              "The campaign changed meanwhile; reload and try again",
            ),
          );
        }

        await tx.campaign.update({
          where: { id },
          data: {
            title: request.title,
            ...(request.banner !== undefined ? { banner: request.banner } : {}),
            description: request.description,
            ...(request.difficulty !== undefined
              ? { difficulty: request.difficulty }
              : {}),
            contactName: optionalText(request.contactName),
            contactPhone: optionalText(request.contactPhone),
            safetyNotes: optionalText(request.safetyNotes),
            minVolunteersReason: optionalText(request.minVolunteersReason),
            ...(request.requirements !== undefined
              ? {
                  requirements:
                    request.requirements === null
                      ? Prisma.DbNull
                      : (request.requirements as Prisma.InputJsonValue),
                }
              : {}),
            updatedBy: userId,
          },
        });

        if (schedule) {
          await campaignLifecycleService.replaceSchedule(tx, id, schedule, userId);
          // Drafts lock nothing; once sent for review, locks follow the meeting points.
          if (before.status !== CampaignStatus.DRAFT) {
            await campaignLifecycleService.syncReportLocks(tx, id, userId);
          }
        }

        if (shouldUpdateManagers) {
          await this.syncManagersForCampaign(tx, id, managerIds, userId);
        }

        const after = await campaignLifecycleService.loadInTx(tx, id);
        if (before.status !== CampaignStatus.DRAFT) {
          await logCampaignEdit(tx, {
            campaignId: id,
            status: before.status,
            actorId: userId,
            changes: diffSnapshots(
              campaignLifecycleService.snapshotOf(before),
              campaignLifecycleService.snapshotOf(after),
            ),
          });
        }
        return after;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );

    return this.toResponseWithVotes(updated, viewerUserId ?? userId);
  }

  /**
   * Legacy `PUT /:id/verify`: status 1 approves, status 2 blocks (under review) or bans
   * (running). Kept for one release while clients move to `PUT /:id/review`.
   */
  async adminVerifyCampaign(
    id: string,
    adminUserId: string,
    targetStatus: GlobalStatus._STATUS_ACTIVE | GlobalStatus._STATUS_INACTIVE,
    rejectReason?: string | null,
  ): Promise<CampaignResponse> {
    return this.reviewCampaign(
      id,
      adminUserId,
      targetStatus === GlobalStatus._STATUS_ACTIVE ? "approve" : "block",
      rejectReason,
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
      const updated = await prisma.$transaction(async (tx) => {
        await transitionCampaign(tx, {
          campaignId: id,
          event: "reject_completion",
          fromStatus: existing.status,
          actor: "admin",
          actorId: adminUserId,
          reason: trimmedReason,
          data: { rejectReason: trimmedReason },
        });
        return campaignLifecycleService.loadInTx(tx, id);
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

    await campaignAccessService.assertCanManage(existing, userId);

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

    const updated = await prisma.$transaction(async (tx) => {
      await transitionCampaign(tx, {
        campaignId: id,
        event: "submit_completion",
        fromStatus: existing.status,
        actor: "manager",
        actorId: userId,
      });
      return campaignLifecycleService.loadInTx(tx, id);
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
      campaignRegistrationRepository.findRegisteredUserIds(
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

    /** Green points per shift attended long enough (spec 4.1, 5.3). */
    const credits = await shiftAttendanceService.completionCredits(id, tier.greenPoints);
    // Everyone registered or present hears the campaign is done (spec 5.4).
    const approvedVolunteerIds = [
      ...new Set([
        ...(await campaignRegistrationRepository.findRegisteredUserIds(id)),
        ...credits.map((c) => c.userId),
      ]),
    ];

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
        await transitionCampaign(tx, {
          campaignId: id,
          event: "approve_completion",
          fromStatus: existing.status,
          actor: "admin",
          actorId: userId,
          data: { rejectReason: null },
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
    const adminIds = getCampaignAdminNotifyUserIds();
    if (adminIds.length === 0) {
      console.warn(
        "[campaign] CAMPAIGN_ADMIN_NOTIFY_USER_IDS empty; skipping admin completion-pending notifications",
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

  /** Spec 3.6: the creator or an owner cancels the campaign, with a reason. */
  async cancelCampaign(id: string, userId: string, reason: string): Promise<CampaignResponse> {
    const campaign = await campaignLifecycleService.cancel(id, userId, reason);
    return this.toResponseWithVotes(campaign, userId);
  }

  async deleteCampaign(id: string, userId: string): Promise<void> {
    const existing = await campaignRepository.findById(id);
    if (!existing) {
      throw new Error("Campaign not found");
    }

    await campaignAccessService.assertCanDelete(existing, userId);
    // Running or finished campaigns are cancelled, never deleted.
    if (!CAMPAIGN_DELETABLE_STATUSES.includes(existing.status)) {
      throw new HttpError(HTTP_STATUS.CAMPAIGN_NOT_DELETABLE);
    }
    // Volunteers registered (an approved campaign under review again): cancel, so they hear.
    if (
      existing.approvedAt != null &&
      (await prisma.campaignShiftRegistration.count({ where: { campaignId: id, leftAt: null } })) > 0
    ) {
      throw new HttpError(HTTP_STATUS.CAMPAIGN_HAS_VOLUNTEERS);
    }

    await prisma.$transaction(
      async (tx) => {
        await campaignLifecycleService.releaseAllReports(tx, id, userId);

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
