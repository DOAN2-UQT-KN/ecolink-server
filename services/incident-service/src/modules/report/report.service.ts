import { reportRepository, ReportWithMediaFiles } from "./report.repository";
import { toReportResponse, toDuplicateVerificationJson, embedDuplicateVerification, omitInactiveDuplicateGroups } from "./report.entity";
import {
  CreateReportRequest,
  UpdateReportRequest,
  AddReportImagesRequest,
  ReportSearchQuery,
  ReportSearchWithScope,
  ReportResponse,
  ReportDetailResponse,
  ReportHandledByResponse,
  PaginatedReportsResponse,
  ReportBackgroundJobsStatusResponse,
  ReportMediaFileByIdResponse,
  DuplicateVerificationGroup,
} from "./report.dto";
import { reportMediaRepository } from "./report_media.repository";
import {
  MediaResourceType,
  ReportStatus,
  SavedResourceType,
  VoteResourceType,
} from "../../constants/status.enum";
import prisma from "../../config/prisma.client";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
  ReportJobType,
  TranslationFieldTarget,
  TranslationResourceType,
} from "../../constants/job-type.enum";
import { backgroundJobDispatcher } from "../../queue/register";
import { backgroundJobRepository } from "../background-job/background-job.repository";
import { HttpError, HTTP_STATUS } from "../../constants/http-status";
import { savedResourceRepository } from "../saved_resource/saved_resource.repository";
import { defaultResourceVoteSummary } from "../vote/vote.dto";
import { voteService } from "../vote/vote.service";
import {
  fetchOrganizationOwnersByUserIds,
  isIdentityCallableUserId,
  getUserProfile,
} from "../organization/identity-user.client";
import type { OrganizationOwnerResponse } from "../organization/organization.dto";
import {
  enqueueReportApprovedWebsiteNotification,
  enqueueReportRejectedWebsiteNotification,
  enqueueReportStatusWebsiteNotification,
} from "./report-status-notify.client";
import { emitOutbox } from "../../outbox/outbox.writer";
import { OutboxEventType } from "../../outbox/outbox.types";
import {
  prepareMediaFromUrl,
  toReportSubmittedMediaSnapshot,
} from "../media/media-from-url.service";

/**
 * Serialize Media metadata for JSON responses (`fileSize` as string).
 */
function toMediaMetadataResponse(media: {
  mimeType: string | null;
  fileSize: bigint | null;
  width: number | null;
  height: number | null;
  capturedAt: Date | null;
  latitude: number | null;
  longitude: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  metadata: unknown;
}): {
  mimeType: string | null;
  fileSize: string | null;
  width: number | null;
  height: number | null;
  capturedAt: Date | null;
  latitude: number | null;
  longitude: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  metadata: unknown | null;
} {
  return {
    mimeType: media.mimeType,
    fileSize: media.fileSize != null ? media.fileSize.toString() : null,
    width: media.width,
    height: media.height,
    capturedAt: media.capturedAt,
    latitude: media.latitude,
    longitude: media.longitude,
    cameraMake: media.cameraMake,
    cameraModel: media.cameraModel,
    metadata: media.metadata ?? null,
  };
}

/**
 * Best-effort enqueue of a TRANSLATE_TEXT job. Failure is logged but does NOT
 * propagate so request handlers stay fast and do not roll back the primary
 * write when SQS is unavailable.
 */
function enqueueReportTranslationJob(
  resourceType: TranslationResourceType,
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
      resourceType,
      resourceId,
      translations: cleaned,
    })
    .catch((err: Error) => {
      console.error(
        "[incident-service] Failed to enqueue translation job:",
        err.message,
      );
    });
}

/** Admin moderation: report is banned / hidden (`GlobalStatus._STATUS_INACTIVE`). */
const REPORT_STATUS_BANNED = ReportStatus._STATUS_INACTIVE;

export class ReportService {
  constructor() {}

  private reporterProfileFallback(userId: string): OrganizationOwnerResponse {
    return { id: userId, name: "", avatar: null, bio: null };
  }

  /**
   * Fills `user` (name, avatar) from identity-service for each report with a `userId`.
   */
  async attachReporterProfilesToReports<T extends ReportResponse>(
    reports: T[],
  ): Promise<T[]> {
    if (reports.length === 0) {
      return reports;
    }
    const rawUserIds = reports
      .map((r) => r.userId)
      .filter((id): id is string => id != null);
    const userIds = [...new Set(rawUserIds)].filter((id) =>
      isIdentityCallableUserId(id),
    );

    if (userIds.length === 0) {
      return reports.map((r) => ({ ...r, user: null }) as T);
    }
    const map = await fetchOrganizationOwnersByUserIds(userIds);
    return reports.map(
      (r) =>
        ({
          ...r,
          user: r.userId
            ? isIdentityCallableUserId(r.userId)
              ? (getUserProfile(map, r.userId) ??
                this.reporterProfileFallback(r.userId))
              : this.reporterProfileFallback(r.userId)
            : null,
        }) as T,
    );
  }

  private async attachVotesToReports<T extends ReportResponse>(
    reports: T[],
    viewerUserId?: string | null,
  ): Promise<T[]> {
    if (reports.length === 0) {
      return reports;
    }
    const ids = reports.map((r) => r.id);
    const [map, savedIds] = await Promise.all([
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
    const withVotes = reports.map((r) => ({
      ...r,
      votes: map.get(r.id) ?? defaultResourceVoteSummary(viewerUserId ?? null),
      saved: viewerUserId != null ? savedIds.has(r.id) : null,
    }));
    return this.attachReporterProfilesToReports(withVotes);
  }

  private async withReportVote(
    report: ReportResponse,
    viewerUserId?: string | null,
  ): Promise<ReportResponse> {
    const [one] = await this.attachVotesToReports([report], viewerUserId);
    return one;
  }

  private isAdminRole(role?: string): boolean {
    return role?.toLowerCase() === "admin";
  }

  /**
   * Only the report owner may edit content/media; admins must use admin-only actions (e.g. ban).
   * Banned reports cannot be edited by the owner.
   */
  private assertReporterMayEditReport(
    report: { userId: string | null; status: number | null },
    userId: string,
    role?: string,
  ): void {
    if (this.isAdminRole(role)) {
      throw new HttpError(
        HTTP_STATUS.FORBIDDEN.withMessage("Admins cannot edit reports"),
      );
    }
    if (report.userId !== userId) {
      throw new HttpError(
        HTTP_STATUS.FORBIDDEN.withMessage(
          "Only the report owner can edit this report",
        ),
      );
    }
    if (report.status === REPORT_STATUS_BANNED) {
      throw new HttpError(
        HTTP_STATUS.FORBIDDEN.withMessage(
          "This report has been banned and cannot be edited",
        ),
      );
    }
  }

  async createReport(
    userId: string,
    request: CreateReportRequest,
    _authorization?: string,
  ): Promise<ReportResponse> {
    const imageUrls = request.imageUrls
      .map((imageUrl) => imageUrl.trim())
      .filter((imageUrl) => imageUrl.length > 0);

    const userTitleVi = request.titleVi?.trim() || "";
    const userTitleEn = request.titleEn?.trim() || "";
    const userDescriptionVi = request.descriptionVi?.trim() || "";
    const userDescriptionEn = request.descriptionEn?.trim() || "";

    const sourceTitle =
      userTitleVi || userTitleEn || request.title.trim();
    const sourceDescription =
      userDescriptionVi ||
      userDescriptionEn ||
      request.description?.trim() ||
      "";

    // Download + EXIF extract before opening the DB transaction (network I/O).
    const preparedMedia =
      imageUrls.length > 0
        ? await Promise.all(
            imageUrls.map((imageUrl, index) =>
              prepareMediaFromUrl({
                id: randomUUID(),
                url: imageUrl,
                type: MediaResourceType.REPORT,
                userId,
                capture: request.mediaCaptures?.[index] ?? null,
              }),
            ),
          )
        : [];

    const reportAndMedia = await prisma.$transaction(async (tx) => {
      const createdReport = await tx.report.create({
        data: {
          userId,
          title: request.title,
          // Translations are filled asynchronously; until the worker runs we
          // store the source text so the row never has empty placeholders.
          titleVi: userTitleVi || sourceTitle,
          titleEn: userTitleEn || sourceTitle,
          description: request.description,
          descriptionVi:
            userDescriptionVi || (sourceDescription || null),
          descriptionEn:
            userDescriptionEn || (sourceDescription || null),
          wasteType: request.wasteType,
          severityLevel: request.severityLevel,
          latitude: request.latitude,
          longitude: request.longitude,
          detailAddress: request.detailAddress,
          status: ReportStatus._STATUS_PENDING,
          isVerify: false,
          aiVerified: false,
        } as any,
      });

      let reportMediaFileIds: string[] = [];
      let mediaSnapshots: Record<string, unknown>[] = [];
      if (preparedMedia.length > 0) {
        const mediaRows = preparedMedia.map((p) => p.media);
        await tx.media.createMany({ data: mediaRows });

        const reportMediaRows = mediaRows.map((m) => ({
          id: randomUUID(),
          reportId: createdReport.id,
          mediaId: m.id!,
          uploadedBy: userId,
          createdBy: userId,
          updatedBy: userId,
        }));

        await tx.reportMediaFile.createMany({ data: reportMediaRows });

        reportMediaFileIds = reportMediaRows.map((r) => r.id);
        mediaSnapshots = reportMediaRows.map((rm, index) =>
          toReportSubmittedMediaSnapshot({
            reportMediaFileId: rm.id,
            mediaId: rm.mediaId,
            uploadedBy: userId,
            media: mediaRows[index]!,
          }),
        );
      }

      await emitOutbox(tx, {
        aggregateType: "report",
        aggregateId: createdReport.id,
        eventType: OutboxEventType.REPORT_SUBMITTED,
        payload: {
          reportId: createdReport.id,
          userId,
          reportMediaFileIds,
          media: mediaSnapshots,
        } as Prisma.InputJsonValue,
        dedupKey: `${OutboxEventType.REPORT_SUBMITTED}:${createdReport.id}`,
      });

      return {
        report: createdReport,
        reportMediaFileIds,
      };
    });

    // Publish async analysis job so report creation stays fast and resilient.
    backgroundJobDispatcher
      .enqueue(ReportJobType.ANALYZE_REPORT, {
        reportId: reportAndMedia.report.id,
        reportMediaFileIds: reportAndMedia.reportMediaFileIds,
      })
      .catch((err: Error) => {
        console.error("Failed to enqueue AI analysis job:", err.message);
      });

    const titleTarget: TranslationFieldTarget = {
      sourceText: sourceTitle,
      viField: userTitleVi ? undefined : "titleVi",
      enField: userTitleEn ? undefined : "titleEn",
    };
    const descriptionTarget: TranslationFieldTarget | null = sourceDescription
      ? {
          sourceText: sourceDescription,
          viField: userDescriptionVi ? undefined : "descriptionVi",
          enField: userDescriptionEn ? undefined : "descriptionEn",
        }
      : null;
    enqueueReportTranslationJob(
      TranslationResourceType.REPORT,
      reportAndMedia.report.id,
      descriptionTarget ? [titleTarget, descriptionTarget] : [titleTarget],
    );

    const [report] = await this.attachVotesToReports(
      [toReportResponse(reportAndMedia.report)],
      userId,
    );
    return report;
  }

  async getReportById(
    id: string,
    viewerUserId?: string | null,
  ): Promise<ReportResponse | null> {
    const report = await reportRepository.findById(id);
    if (!report) {
      return null;
    }
    return this.withReportVote(toReportResponse(report), viewerUserId);
  }

  async saveDuplicateVerification(
    reportId: string,
    verification: DuplicateVerificationGroup[],
  ): Promise<void> {
    const existing = await reportRepository.findById(reportId);
    if (!existing) {
      throw new HttpError(HTTP_STATUS.REPORT_NOT_FOUND);
    }

    const isDuplicate = verification.length > 0;
    const updateData: Prisma.ReportUpdateInput = {
      duplicateVerification: toDuplicateVerificationJson(verification),
    };

    if (isDuplicate) {
      updateData.status = REPORT_STATUS_BANNED;
      updateData.rejectReason = "DUPLICATE_IMAGE";
    }

    const updated = await reportRepository.update(reportId, updateData);

    if (isDuplicate && existing.status !== REPORT_STATUS_BANNED) {
      this.notifyOwnerOfReportModeration(
        updated,
        "banned",
        updateData.rejectReason as string,
      );
    }
  }

  /**
   * Report ids the duplicate cascade must ignore: banned (`_STATUS_INACTIVE`)
   * or soft-deleted. Missing ids are not included.
   */
  async findInactiveReportIds(reportIds: string[]): Promise<string[]> {
    const ids = [...new Set(reportIds.filter((id) => id))];
    if (ids.length === 0) {
      return [];
    }
    const rows = await prisma.report.findMany({
      where: {
        id: { in: ids },
        OR: [
          { status: REPORT_STATUS_BANNED },
          { deletedAt: { not: null } },
        ],
      },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async getReportBackgroundJobsStatus(
    reportId: string,
  ): Promise<ReportBackgroundJobsStatusResponse | null> {
    const report = await reportRepository.findById(reportId);
    if (!report) return null;

    const { total, pendingOrInProcess } =
      await backgroundJobRepository.countJobsForPayload(
        ReportJobType.ANALYZE_REPORT,
        ["reportId"],
        reportId,
      );

    return {
      allDone: pendingOrInProcess === 0,
      jobCount: total,
      pendingOrInProcessCount: pendingOrInProcess,
    };
  }

  async getReportDetail(
    id: string,
    viewerUserId?: string | null,
  ): Promise<ReportDetailResponse | null> {
    const report = await reportRepository.findByIdWithRelations(id);
    if (!report) return null;
    if (report.status === REPORT_STATUS_BANNED) return null;

    const [details] = await this.reportsWithMediaToDetails([
      report as ReportWithMediaFiles,
    ]);
    const [withVotes] = await this.attachVotesToReports(
      [details],
      viewerUserId,
    );
    return withVotes;
  }

  /** reportIds limited to 100 UUIDs at the controller; order matches request. */
  async getReportsByIds(
    ids: string[],
    viewerUserId?: string | null,
  ): Promise<ReportDetailResponse[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await reportRepository.findManyByIdsWithRelations(ids);
    const byId = new Map(
      rows.map((row) => [row.id, row as ReportWithMediaFiles]),
    );
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((row): row is ReportWithMediaFiles => row !== undefined);
    const details = await this.reportsWithMediaToDetails(ordered);
    return this.attachVotesToReports(details, viewerUserId);
  }

  /**
   * Batch lookup of report_media_files by id. Only files the viewer may see
   * (report owner or verified report) are returned; order matches `ids`.
   */
  async getReportMediaFilesByIds(
    ids: string[],
    viewerUserId: string,
  ): Promise<ReportMediaFileByIdResponse[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await reportMediaRepository.findManyByIdsVisibleToViewer(
      ids,
      viewerUserId,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: ReportMediaFileByIdResponse[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) {
        continue;
      }
      out.push({
        id: row.id,
        reportId: row.reportId,
        mediaId: row.mediaId,
        url: row.media.url,
        type: row.media.type,
        createdAt: row.createdAt,
        ...toMediaMetadataResponse(row.media),
      });
    }
    return out;
  }

  private toHandledBy(
    org:
      | {
          id: string;
          name: string;
          slug: string;
          logoUrl: string;
          backgroundUrl: string | null;
          contactEmail: string | null;
          deletedAt: Date | null;
        }
      | null
      | undefined,
  ): ReportHandledByResponse | null {
    if (!org || org.deletedAt) {
      return null;
    }
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      logoUrl: org.logoUrl,
      backgroundUrl: org.backgroundUrl,
      contactEmail: org.contactEmail,
    };
  }

  private async attachHandledBy(
    reports: { campaignId: string | null }[],
    details: ReportDetailResponse[],
  ): Promise<ReportDetailResponse[]> {
    const campaignIds = [
      ...new Set(
        reports
          .map((r) => r.campaignId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (campaignIds.length === 0) {
      return details.map((d) => ({ ...d, handledBy: null }));
    }

    const campaigns = await prisma.campaign.findMany({
      where: { id: { in: campaignIds }, deletedAt: null },
      select: {
        id: true,
        organization: {
          select: {
            id: true,
            name: true,
            slug: true,
            logoUrl: true,
            backgroundUrl: true,
            contactEmail: true,
            deletedAt: true,
          },
        },
      },
    });

    const handledByByCampaignId = new Map(
      campaigns.map((c) => [c.id, this.toHandledBy(c.organization)]),
    );

    return details.map((d, i) => ({
      ...d,
      handledBy:
        handledByByCampaignId.get(reports[i]?.campaignId ?? "") ?? null,
    }));
  }

  private toReportDetailFromLoaded(
    report: ReportWithMediaFiles & { distance?: number },
    mediaMap: Map<
      string,
      {
        url: string;
        type: string;
        mimeType: string | null;
        fileSize: bigint | null;
        width: number | null;
        height: number | null;
        capturedAt: Date | null;
        latitude: number | null;
        longitude: number | null;
        cameraMake: string | null;
        cameraModel: string | null;
        metadata: unknown;
      }
    >,
    aiAnalysisUrlMap: Map<string, string>,
  ): ReportDetailResponse {
    return {
      ...toReportResponse(report, report.distance),
      mediaFiles: report.reportMediaFiles.map((mf) => {
        const media = mediaMap.get(mf.mediaId);
        return {
          id: mf.id,
          mediaId: mf.mediaId,
          url: media?.url ?? null,
          type: media?.type ?? null,
          ai_analysis_url: aiAnalysisUrlMap.get(mf.id) ?? null,
          uploadedBy: mf.uploadedBy,
          createdAt: mf.createdAt,
          ...(media
            ? toMediaMetadataResponse(media)
            : {
                mimeType: null,
                fileSize: null,
                width: null,
                height: null,
                capturedAt: null,
                latitude: null,
                longitude: null,
                cameraMake: null,
                cameraModel: null,
                metadata: null,
              }),
        };
      }),
      handledBy: null,
    };
  }

  private async reportsWithMediaToDetails(
    reports: (ReportWithMediaFiles & { distance?: number })[],
  ): Promise<ReportDetailResponse[]> {
    const mediaIds: string[] = [];
    const reportMediaFileIds: string[] = [];
    for (const r of reports) {
      for (const mf of r.reportMediaFiles) {
        mediaIds.push(mf.mediaId);
        reportMediaFileIds.push(mf.id);
      }
    }

    const [mediaMap, aiAnalysisUrlMap] = await Promise.all([
      this.getMediaMap([...new Set(mediaIds)]),
      this.getAiAnalysisUrlMap([...new Set(reportMediaFileIds)]),
    ]);

    const details = reports.map((r) =>
      this.toReportDetailFromLoaded(r, mediaMap, aiAnalysisUrlMap),
    );
    const withHandledBy = await this.attachHandledBy(reports, details);
    return this.attachDuplicateSummaries(withHandledBy, mediaMap);
  }

  private async attachDuplicateSummaries(
    details: ReportDetailResponse[],
    mediaMap: Map<string, { url: string }>,
  ): Promise<ReportDetailResponse[]> {
    const reportIds = new Set<string>();
    const extraMediaIds = new Set<string>();
    for (const detail of details) {
      for (const group of detail.duplicateVerification ?? []) {
        reportIds.add(group.duplicateReportId);
        for (const match of group.matches) {
          if (!mediaMap.has(match.newMedia.mediaId)) {
            extraMediaIds.add(match.newMedia.mediaId);
          }
          if (!mediaMap.has(match.duplicateMedia.duplicateMediaId)) {
            extraMediaIds.add(match.duplicateMedia.duplicateMediaId);
          }
        }
      }
    }

    const urlByMediaId = new Map<string, string>();
    for (const [id, media] of mediaMap) {
      urlByMediaId.set(id, media.url);
    }

    const [reportRows, mediaRows] = await Promise.all([
      reportIds.size === 0
        ? Promise.resolve([])
        : prisma.report.findMany({
            where: { id: { in: [...reportIds] }, deletedAt: null },
            select: {
              id: true,
              title: true,
              titleVi: true,
              detailAddress: true,
              status: true,
            },
          }),
      extraMediaIds.size === 0
        ? Promise.resolve([])
        : prisma.media.findMany({
            where: { id: { in: [...extraMediaIds] }, deletedAt: null },
            select: { id: true, url: true },
          }),
    ]);

    for (const media of mediaRows) {
      urlByMediaId.set(media.id, media.url);
    }
    const reportsById = new Map(reportRows.map((row) => [row.id, row]));

    return details.map((detail) => ({
      ...detail,
      duplicateVerification:
        detail.duplicateVerification == null
          ? null
          : embedDuplicateVerification(
              omitInactiveDuplicateGroups(
                detail.duplicateVerification.map((group) => ({
                  duplicateReportId: group.duplicateReportId,
                  matches: group.matches.map((match) => ({
                    mediaId: match.newMedia.mediaId,
                    duplicateMediaId: match.duplicateMedia.duplicateMediaId,
                  })),
                })),
                reportsById,
              ),
              reportsById,
              urlByMediaId,
            ),
    }));
  }

  private async getAiAnalysisUrlMap(
    reportMediaFileIds: string[],
  ): Promise<Map<string, string>> {
    if (reportMediaFileIds.length === 0) {
      return new Map();
    }

    const aiLogs = await prisma.aiAnalysisLog.findMany({
      where: {
        reportMediaFileId: { in: reportMediaFileIds },
        mediaId: { not: null },
      },
      select: {
        reportMediaFileId: true,
        mediaId: true,
        processedAt: true,
      },
      orderBy: {
        processedAt: "desc",
      },
    });

    const mediaIds = aiLogs
      .map((log) => log.mediaId)
      .filter((mediaId): mediaId is string => Boolean(mediaId));

    if (mediaIds.length === 0) {
      return new Map();
    }

    const mediaRecords = await prisma.media.findMany({
      where: {
        id: { in: mediaIds },
        deletedAt: null,
      },
      select: {
        id: true,
        url: true,
      },
    });

    const mediaUrlMap = new Map(
      mediaRecords.map((item) => [item.id, item.url]),
    );
    const aiAnalysisUrlMap = new Map<string, string>();

    for (const log of aiLogs) {
      if (!log.reportMediaFileId || !log.mediaId) {
        continue;
      }

      // Keep the most recent analysis URL per media file.
      if (aiAnalysisUrlMap.has(log.reportMediaFileId)) {
        continue;
      }

      const aiAnalysisUrl = mediaUrlMap.get(log.mediaId);
      if (aiAnalysisUrl) {
        aiAnalysisUrlMap.set(log.reportMediaFileId, aiAnalysisUrl);
      }
    }

    return aiAnalysisUrlMap;
  }

  async updateReport(
    id: string,
    request: UpdateReportRequest,
    userId: string,
    role?: string,
    viewerUserId?: string | null,
    _authorization?: string,
  ): Promise<ReportResponse> {
    const existing = await reportRepository.findById(id);
    if (!existing) {
      throw new HttpError(HTTP_STATUS.REPORT_NOT_FOUND);
    }

    this.assertReporterMayEditReport(existing, userId, role);

    const userTitleVi = request.titleVi?.trim() || "";
    const userTitleEn = request.titleEn?.trim() || "";
    const userDescriptionVi = request.descriptionVi?.trim() || "";
    const userDescriptionEn = request.descriptionEn?.trim() || "";

    const sourceTitle =
      userTitleVi || userTitleEn || request.title?.trim() || "";
    const sourceDescription =
      userDescriptionVi ||
      userDescriptionEn ||
      request.description?.trim() ||
      "";

    const report = await reportRepository.update(id, {
      title: request.title,
      // For unset language fields, write the source text as a placeholder; the
      // background worker overwrites it with the real translation when it runs.
      titleVi: sourceTitle ? userTitleVi || sourceTitle : request.titleVi,
      titleEn: sourceTitle ? userTitleEn || sourceTitle : request.titleEn,
      description: request.description,
      descriptionVi: sourceDescription
        ? userDescriptionVi || sourceDescription
        : request.descriptionVi,
      descriptionEn: sourceDescription
        ? userDescriptionEn || sourceDescription
        : request.descriptionEn,
      wasteType: request.wasteType,
      severityLevel: request.severityLevel,
      latitude: request.latitude,
      longitude: request.longitude,
      detailAddress: request.detailAddress,
    } as any);

    const translations: TranslationFieldTarget[] = [];
    if (sourceTitle && (!userTitleVi || !userTitleEn)) {
      translations.push({
        sourceText: sourceTitle,
        viField: userTitleVi ? undefined : "titleVi",
        enField: userTitleEn ? undefined : "titleEn",
      });
    }
    if (sourceDescription && (!userDescriptionVi || !userDescriptionEn)) {
      translations.push({
        sourceText: sourceDescription,
        viField: userDescriptionVi ? undefined : "descriptionVi",
        enField: userDescriptionEn ? undefined : "descriptionEn",
      });
    }
    enqueueReportTranslationJob(
      TranslationResourceType.REPORT,
      report.id,
      translations,
    );

    return this.withReportVote(
      toReportResponse(report),
      viewerUserId ?? userId,
    );
  }

  /**
   * Append images to a report. Only the report owner may add images (not managers or admins).
   */
  async addReportImages(
    reportId: string,
    userId: string,
    request: AddReportImagesRequest,
    role?: string,
    viewerUserId?: string | null,
  ): Promise<ReportResponse> {
    const existing = await reportRepository.findById(reportId);
    if (!existing) {
      throw new HttpError(HTTP_STATUS.REPORT_NOT_FOUND);
    }

    this.assertReporterMayEditReport(existing, userId, role);

    const imageUrls = request.imageUrls
      .map((url) => url.trim())
      .filter((url) => url.length > 0);

    if (imageUrls.length === 0) {
      throw new HttpError(
        HTTP_STATUS.BAD_REQUEST.withMessage(
          "imageUrls must contain at least one non-empty URL",
        ),
      );
    }

    // Download + EXIF extract before the DB transaction.
    const preparedMedia = await Promise.all(
      imageUrls.map((imageUrl, index) =>
        prepareMediaFromUrl({
          url: imageUrl,
          type: MediaResourceType.REPORT,
          userId,
          capture: request.mediaCaptures?.[index] ?? null,
        }),
      ),
    );

    const reportMediaFileIds = await prisma.$transaction(async (tx) => {
      const createdIds: string[] = [];

      for (const prepared of preparedMedia) {
        const media = await tx.media.create({ data: prepared.media });

        const reportMediaFile = await tx.reportMediaFile.create({
          data: {
            reportId,
            mediaId: media.id,
            uploadedBy: userId,
            createdBy: userId,
            updatedBy: userId,
          },
          select: { id: true },
        });

        createdIds.push(reportMediaFile.id);
      }

      return createdIds;
    });

    await reportRepository.update(reportId, {
      aiVerified: false,
      status: ReportStatus._STATUS_PENDING,
      duplicateVerification: Prisma.DbNull,
    });

    backgroundJobDispatcher
      .enqueue(ReportJobType.ANALYZE_REPORT, {
        reportId,
        reportMediaFileIds,
      })
      .catch((err: Error) => {
        console.error("Failed to enqueue AI analysis job:", err.message);
      });

    const updated = await reportRepository.findById(reportId);
    return this.withReportVote(
      toReportResponse(updated!),
      viewerUserId ?? userId,
    );
  }

  /**
   * Soft-delete a report media file. Only the report owner may delete (not managers or admins).
   */
  async deleteReportMediaFile(
    reportId: string,
    reportMediaFileId: string,
    userId: string,
    role?: string,
    viewerUserId?: string | null,
  ): Promise<ReportResponse> {
    const existing = await reportRepository.findById(reportId);
    if (!existing) {
      throw new HttpError(HTTP_STATUS.REPORT_NOT_FOUND);
    }

    this.assertReporterMayEditReport(existing, userId, role);

    const mediaFile = await reportMediaRepository.findById(reportMediaFileId);
    if (!mediaFile || mediaFile.reportId !== reportId) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Report media file not found"),
      );
    }

    await reportMediaRepository.softDelete(reportMediaFileId);

    const updated = await reportRepository.findById(reportId);
    return this.withReportVote(
      toReportResponse(updated!),
      viewerUserId ?? userId,
    );
  }

  /**
   * Ban a report (moderation). Admin-only; sets status to inactive (banned).
   * `rejectReason` is required. Already-banned reports can update the reason
   * without a second notification.
   */
  async adminBanReport(
    id: string,
    viewerUserId?: string | null,
    rejectReason?: string | null,
  ): Promise<ReportResponse> {
    const existing = await reportRepository.findById(id);
    if (!existing) {
      throw new HttpError(HTTP_STATUS.REPORT_NOT_FOUND);
    }

    const trimmedReason =
      typeof rejectReason === "string" ? rejectReason.trim() : "";
    if (!trimmedReason) {
      throw new HttpError(
        HTTP_STATUS.VALIDATION_ERROR.withMessage(
          "reject_reason is required when banning a report",
        ),
      );
    }

    if (existing.status === REPORT_STATUS_BANNED) {
      if (existing.rejectReason === trimmedReason) {
        return this.withReportVote(toReportResponse(existing), viewerUserId);
      }
      const updated = await reportRepository.update(id, {
        rejectReason: trimmedReason,
      });
      return this.withReportVote(toReportResponse(updated), viewerUserId);
    }

    const report = await reportRepository.update(id, {
      status: REPORT_STATUS_BANNED,
      rejectReason: trimmedReason,
    });
    this.notifyOwnerOfReportModeration(report, "banned", trimmedReason);
    return this.withReportVote(toReportResponse(report), viewerUserId);
  }

  /**
   * Mark report completed (admin workflow). Admin-only at controller layer.
   */
  async adminMarkReportDone(
    id: string,
    viewerUserId?: string | null,
  ): Promise<ReportResponse> {
    const existing = await reportRepository.findById(id);
    if (!existing) {
      throw new HttpError(HTTP_STATUS.REPORT_NOT_FOUND);
    }

    if (existing.status === ReportStatus._STATUS_COMPLETED) {
      return this.withReportVote(toReportResponse(existing), viewerUserId);
    }

    const points = Number(process.env.REPORT_COMPLETION_GREEN_POINTS ?? 0) || 0;

    // Mark done and emit the green-point credit event atomically. The outbox
    // relay delivers it to reward-service, so "done" stays done even if reward
    // is down — no rollback of business state.
    const report = await prisma.$transaction(async (tx) => {
      const updated = await reportRepository.markReportAsDone(id, tx);
      if (updated.userId) {
        await emitOutbox(tx, {
          aggregateType: "report",
          aggregateId: updated.id,
          eventType: OutboxEventType.REPORT_COMPLETION_GREEN_POINTS,
          payload: { reportId: updated.id, userId: updated.userId, points },
          dedupKey: `${OutboxEventType.REPORT_COMPLETION_GREEN_POINTS}:${updated.id}`,
        });
      }
      return updated;
    });

    const recipientUserId = report.userId;
    if (recipientUserId) {
      // Best-effort in-app message; do not block the main action if notifications fail.
      try {
        await enqueueReportStatusWebsiteNotification({
          userId: recipientUserId,
          reportId: report.id,
          reportTitle: report.title || "Untitled report",
          status: "COMPLETED",
        });
      } catch (e) {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[incident-service] report status notification failed", {
            reportId: report.id,
            userId: recipientUserId,
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    return this.withReportVote(toReportResponse(report), viewerUserId);
  }

  /**
   * Admin approval: marks report verified and sets status TODO (eligible for campaigns;
   * separate from AI `aiVerified`). Already verified and not banned: no-op.
   */
  async adminVerifyReport(
    id: string,
    viewerUserId?: string | null,
  ): Promise<ReportResponse> {
    const existing = await reportRepository.findById(id);
    if (!existing) {
      throw new HttpError(HTTP_STATUS.REPORT_NOT_FOUND);
    }

    if (
      existing.isVerify &&
      existing.status !== REPORT_STATUS_BANNED
    ) {
      return this.withReportVote(toReportResponse(existing), viewerUserId);
    }

    const report = await reportRepository.update(id, {
      isVerify: true,
      status: ReportStatus._STATUS_TODO,
      rejectReason: null,
    });
    this.notifyOwnerOfReportModeration(report, "approved");
    return this.withReportVote(toReportResponse(report), viewerUserId);
  }

  /** Best-effort in-app notice to the report owner after admin verify/ban. */
  private notifyOwnerOfReportModeration(
    report: { id: string; userId: string | null; title: string | null },
    outcome: "approved" | "banned",
    rejectReason?: string,
  ): void {
    const ownerId = report.userId;
    if (!ownerId) return;
    const reportTitle = report.title?.trim() || "Untitled report";
    const run =
      outcome === "approved"
        ? enqueueReportApprovedWebsiteNotification({
            userId: ownerId,
            reportId: report.id,
            reportTitle,
          })
        : enqueueReportRejectedWebsiteNotification({
            userId: ownerId,
            reportId: report.id,
            reportTitle,
            rejectReason: rejectReason ?? "",
          });
    void run.catch((err) => {
      console.warn(
        `[report] failed to notify owner of report ${outcome}`,
        err,
      );
    });
  }

  private async getMediaMap(
    mediaIds: string[],
  ): Promise<
    Map<
      string,
      {
        url: string;
        type: string;
        mimeType: string | null;
        fileSize: bigint | null;
        width: number | null;
        height: number | null;
        capturedAt: Date | null;
        latitude: number | null;
        longitude: number | null;
        cameraMake: string | null;
        cameraModel: string | null;
        metadata: unknown;
      }
    >
  > {
    if (mediaIds.length === 0) {
      return new Map();
    }

    const mediaRecords = await prisma.media.findMany({
      where: {
        id: { in: mediaIds },
        deletedAt: null,
      },
      select: {
        id: true,
        url: true,
        type: true,
        mimeType: true,
        fileSize: true,
        width: true,
        height: true,
        capturedAt: true,
        latitude: true,
        longitude: true,
        cameraMake: true,
        cameraModel: true,
        metadata: true,
      },
    });

    return new Map(
      mediaRecords.map((item) => [
        item.id,
        {
          url: item.url,
          type: item.type,
          mimeType: item.mimeType,
          fileSize: item.fileSize,
          width: item.width,
          height: item.height,
          capturedAt: item.capturedAt,
          latitude: item.latitude,
          longitude: item.longitude,
          cameraMake: item.cameraMake,
          cameraModel: item.cameraModel,
          metadata: item.metadata,
        },
      ]),
    );
  }

  async deleteReport(id: string, userId: string, role?: string): Promise<void> {
    const existing = await reportRepository.findById(id);
    if (!existing) {
      throw new HttpError(HTTP_STATUS.REPORT_NOT_FOUND);
    }

    this.assertReporterMayEditReport(existing, userId, role);

    await reportRepository.softDelete(id);
  }

  /**
   * Current user's reports: same filters, sort, and pagination as GET /reports/search.
   */
  async searchMyReports(
    userId: string,
    query: ReportSearchQuery,
  ): Promise<PaginatedReportsResponse> {
    const scoped: ReportSearchWithScope = { ...query, scopedUserId: userId };
    return this.searchReports(scoped, userId);
  }

  /**
   * All reports with status ACTIVE (`GlobalStatus._STATUS_ACTIVE`), no pagination.
   */
  async getAllActiveReports(
    viewerUserId?: string | null,
  ): Promise<ReportDetailResponse[]> {
    const rows = await reportRepository.findAllToDo();
    const details = await this.reportsWithMediaToDetails(rows);
    return this.attachVotesToReports(details, viewerUserId);
  }

  async searchReports(
    query: ReportSearchWithScope,
    viewerUserId?: string | null,
  ): Promise<PaginatedReportsResponse> {
    const page = query.page || 1;
    const limit = query.limit || 10;

    // If user provides location, use geospatial search
    if (query.latitude !== undefined && query.longitude !== undefined) {
      const { reports, total } = await reportRepository.searchWithDistance(
        query.latitude,
        query.longitude,
        query,
      );

      const details = await this.reportsWithMediaToDetails(reports);
      const withVotes = await this.attachVotesToReports(details, viewerUserId);

      return {
        reports: withVotes,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      };
    }

    // Otherwise, use standard search
    const { reports, total } = await reportRepository.search(query);
    const details = await this.reportsWithMediaToDetails(reports);
    const withVotes = await this.attachVotesToReports(details, viewerUserId);

    return {
      reports: withVotes,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Update report status
   */
  async updateReportStatus(
    id: string,
    status: number,
    viewerUserId?: string | null,
  ): Promise<ReportResponse> {
    const existing = await reportRepository.findById(id);
    if (!existing) {
      throw new HttpError(HTTP_STATUS.REPORT_NOT_FOUND);
    }

    const report = await reportRepository.update(id, { status });
    return this.withReportVote(toReportResponse(report), viewerUserId);
  }

  /**
   * Check if user is the reporter of a report
   */
  async isReporter(reportId: string, userId: string): Promise<boolean> {
    const report = await reportRepository.findById(reportId);
    return report?.userId === userId;
  }
}

// Singleton instance
export const reportService = new ReportService();
