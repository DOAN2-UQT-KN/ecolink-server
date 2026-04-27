import {
  reportRepository,
  ReportWithMediaFiles,
} from "./report.repository";
import { toReportResponse } from "./report.entity";
import {
  CreateReportRequest,
  UpdateReportRequest,
  AddReportImagesRequest,
  ReportSearchQuery,
  ReportSearchWithScope,
  ReportResponse,
  ReportDetailResponse,
  PaginatedReportsResponse,
  ReportBackgroundJobsStatusResponse,
  ReportMediaFileByIdResponse,
} from "./report.dto";
import { reportMediaRepository } from "./report_media.repository";
import {
  MediaResourceType,
  ReportStatus,
  SavedResourceType,
  VoteResourceType,
} from "../../constants/status.enum";
import prisma from "../../config/prisma.client";
import { randomUUID } from "node:crypto";
import { ReportJobType } from "../../constants/job-type.enum";
import { backgroundJobDispatcher } from "../../queue/register";
import { backgroundJobRepository } from "../background-job/background-job.repository";
import { HttpError, HTTP_STATUS } from "../../constants/http-status";
import { savedResourceRepository } from "../saved_resource/saved_resource.repository";
import { defaultResourceVoteSummary } from "../vote/vote.dto";
import { voteService } from "../vote/vote.service";
import {
  fetchOrganizationOwnersByUserIds,
  getUserProfile,
} from "../organization/identity-user.client";
import type { OrganizationOwnerResponse } from "../organization/organization.dto";

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
    const userIds = [
      ...new Set(
        reports.map((r) => r.userId).filter((id): id is string => id != null),
      ),
    ];
    if (userIds.length === 0) {
      return reports.map(
        (r) => ({ ...r, user: null }) as T,
      );
    }
    const map = await fetchOrganizationOwnersByUserIds(userIds);
    return reports.map(
      (r) =>
        ({
          ...r,
          user: r.userId
            ? (getUserProfile(map, r.userId) ??
              this.reporterProfileFallback(r.userId))
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
      votes:
        map.get(r.id) ?? defaultResourceVoteSummary(viewerUserId ?? null),
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
  ): Promise<ReportResponse> {
    const imageUrls = request.imageUrls
      .map((imageUrl) => imageUrl.trim())
      .filter((imageUrl) => imageUrl.length > 0);

    const reportAndMedia = await prisma.$transaction(async (tx) => {
      const createdReport = await tx.report.create({
        data: {
          userId,
          title: request.title,
          description: request.description,
          wasteType: request.wasteType,
          severityLevel: request.severityLevel,
          latitude: request.latitude,
          longitude: request.longitude,
          detailAddress: request.detailAddress,
          status: ReportStatus._STATUS_PENDING,
          isVerify: false,
          aiVerified: false,
        },
      });

      let reportMediaFileIds: string[] = [];
      if (imageUrls.length > 0) {
        const mediaRows = imageUrls.map((imageUrl) => ({
          id: randomUUID(),
          url: imageUrl,
          type: MediaResourceType.REPORT,
          createdBy: userId,
          updatedBy: userId,
        }));

        await tx.media.createMany({ data: mediaRows });

        const reportMediaRows = mediaRows.map((m) => ({
          id: randomUUID(),
          reportId: createdReport.id,
          mediaId: m.id,
          uploadedBy: userId,
          createdBy: userId,
          updatedBy: userId,
        }));

        await tx.reportMediaFile.createMany({ data: reportMediaRows });

        reportMediaFileIds = reportMediaRows.map((r) => r.id);
      }

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
      });
    }
    return out;
  }

  private toReportDetailFromLoaded(
    report: ReportWithMediaFiles & { distance?: number },
    mediaUrlMap: Map<string, string>,
    aiAnalysisUrlMap: Map<string, string>,
  ): ReportDetailResponse {
    return {
      ...toReportResponse(report, report.distance),
      mediaFiles: report.reportMediaFiles.map((mf) => ({
        id: mf.id,
        mediaId: mf.mediaId,
        url: mediaUrlMap.get(mf.mediaId) ?? null,
        ai_analysis_url: aiAnalysisUrlMap.get(mf.id) ?? null,
        uploadedBy: mf.uploadedBy,
        createdAt: mf.createdAt,
      })),
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

    const [mediaUrlMap, aiAnalysisUrlMap] = await Promise.all([
      this.getMediaUrlMap([...new Set(mediaIds)]),
      this.getAiAnalysisUrlMap([...new Set(reportMediaFileIds)]),
    ]);

    return reports.map((r) =>
      this.toReportDetailFromLoaded(r, mediaUrlMap, aiAnalysisUrlMap),
    );
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
  ): Promise<ReportResponse> {
    const existing = await reportRepository.findById(id);
    if (!existing) {
      throw new HttpError(HTTP_STATUS.REPORT_NOT_FOUND);
    }

    this.assertReporterMayEditReport(existing, userId, role);

    const report = await reportRepository.update(id, {
      title: request.title,
      description: request.description,
      wasteType: request.wasteType,
      severityLevel: request.severityLevel,
      latitude: request.latitude,
      longitude: request.longitude,
      detailAddress: request.detailAddress,
    });

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

    const reportMediaFileIds = await prisma.$transaction(async (tx) => {
      const createdIds: string[] = [];

      for (const imageUrl of imageUrls) {
        const media = await tx.media.create({
          data: {
            url: imageUrl,
            type: MediaResourceType.REPORT,
            createdBy: userId,
            updatedBy: userId,
          },
        });

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
   */
  async adminBanReport(
    id: string,
    viewerUserId?: string | null,
  ): Promise<ReportResponse> {
    const existing = await reportRepository.findById(id);
    if (!existing) {
      throw new HttpError(HTTP_STATUS.REPORT_NOT_FOUND);
    }

    if (existing.status === REPORT_STATUS_BANNED) {
      return this.withReportVote(toReportResponse(existing), viewerUserId);
    }

    const report = await reportRepository.update(id, {
      status: REPORT_STATUS_BANNED,
    });
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

    const report = await reportRepository.markReportAsDone(id);
    return this.withReportVote(toReportResponse(report), viewerUserId);
  }

  /**
   * Admin approval: marks report verified and sets status pending (eligible for campaigns;
   * separate from AI `aiVerified`).
   */
  async adminVerifyReport(
    id: string,
    viewerUserId?: string | null,
  ): Promise<ReportResponse> {
    const existing = await reportRepository.findById(id);
    if (!existing) {
      throw new HttpError(HTTP_STATUS.REPORT_NOT_FOUND);
    }

    if (existing.isVerify) {
      return this.withReportVote(toReportResponse(existing), viewerUserId);
    }

    const report = await reportRepository.update(id, {
      isVerify: true,
      status: ReportStatus._STATUS_TODO,
    });
    return this.withReportVote(toReportResponse(report), viewerUserId);
  }

  private async getMediaUrlMap(
    mediaIds: string[],
  ): Promise<Map<string, string>> {
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

    return new Map(mediaRecords.map((item) => [item.id, item.url]));
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
