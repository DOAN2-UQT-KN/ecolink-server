import { reportRepository } from "./report.repository";
import { toReportResponse } from "./report.entity";
import {
  CreateReportRequest,
  UpdateReportRequest,
  AddReportImagesRequest,
  ReportSearchQuery,
  ReportResponse,
  ReportDetailResponse,
  PaginatedReportsResponse,
} from "./report.dto";
import { reportMediaRepository } from "./report_media.repository";
import {
  ReportStatus,
  MediaFileStage,
  MediaResourceType,
} from "../../constants/status.enum";
import prisma from "../../config/prisma.client";
import { randomUUID } from "node:crypto";
import { reportAnalysisQueueService } from "./queue/report-analysis-queue.service";

/** Admin moderation: report is banned (same numeric value as GlobalStatus._STATUS_REJECTED). */
const REPORT_STATUS_BANNED = ReportStatus._STATUS_REJECTED;

export class ReportService {
  constructor() {}

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
      throw new Error("Admins cannot edit reports");
    }
    if (report.userId !== userId) {
      throw new Error("Only the report owner can edit this report");
    }
    if (report.status === REPORT_STATUS_BANNED) {
      throw new Error("This report has been banned and cannot be edited");
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
          status: ReportStatus._STATUS_PENDING,
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
          stage: MediaFileStage.BEFORE,
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
    reportAnalysisQueueService
      .enqueueAnalysis(
        reportAndMedia.report.id,
        reportAndMedia.reportMediaFileIds,
      )
      .catch((err) => {
        console.error("Failed to enqueue AI analysis job:", err.message);
      });

    return toReportResponse(reportAndMedia.report);
  }

  async getReportById(id: string): Promise<ReportResponse | null> {
    const report = await reportRepository.findById(id);
    return report ? toReportResponse(report) : null;
  }

  async getReportDetail(id: string): Promise<ReportDetailResponse | null> {
    const report = await reportRepository.findByIdWithRelations(id);
    if (!report) return null;

    const mediaUrlMap = await this.getMediaUrlMap(
      report.reportMediaFiles.map((mf) => mf.mediaId),
    );

    return {
      ...toReportResponse(report),
      mediaFiles: report.reportMediaFiles.map((mf) => ({
        id: mf.id,
        mediaId: mf.mediaId,
        url: mediaUrlMap.get(mf.mediaId) ?? null,
        stage: mf.stage,
        uploadedBy: mf.uploadedBy,
        createdAt: mf.createdAt,
      }))
    };
  }

  async updateReport(
    id: string,
    request: UpdateReportRequest,
    userId: string,
    role?: string,
  ): Promise<ReportResponse> {
    const existing = await reportRepository.findById(id);
    if (!existing) {
      throw new Error("Report not found");
    }

    this.assertReporterMayEditReport(existing, userId, role);

    const report = await reportRepository.update(id, {
      title: request.title,
      description: request.description,
      wasteType: request.wasteType,
      severityLevel: request.severityLevel,
      latitude: request.latitude,
      longitude: request.longitude,
    });

    return toReportResponse(report);
  }

  /**
   * Append images to a report. Only the report owner may add images (not managers or admins).
   */
  async addReportImages(
    reportId: string,
    userId: string,
    request: AddReportImagesRequest,
    role?: string,
  ): Promise<ReportResponse> {
    const existing = await reportRepository.findById(reportId);
    if (!existing) {
      throw new Error("Report not found");
    }

    this.assertReporterMayEditReport(existing, userId, role);

    const imageUrls = request.imageUrls
      .map((url) => url.trim())
      .filter((url) => url.length > 0);

    if (imageUrls.length === 0) {
      throw new Error("imageUrls must contain at least one non-empty URL");
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
            stage: MediaFileStage.BEFORE,
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

    reportAnalysisQueueService
      .enqueueAnalysis(reportId, reportMediaFileIds)
      .catch((err) => {
        console.error("Failed to enqueue AI analysis job:", err.message);
      });

    const updated = await reportRepository.findById(reportId);
    return toReportResponse(updated!);
  }

  /**
   * Soft-delete a report media file. Only the report owner may delete (not managers or admins).
   */
  async deleteReportMediaFile(
    reportId: string,
    reportMediaFileId: string,
    userId: string,
    role?: string,
  ): Promise<ReportResponse> {
    const existing = await reportRepository.findById(reportId);
    if (!existing) {
      throw new Error("Report not found");
    }

    this.assertReporterMayEditReport(existing, userId, role);

    const mediaFile = await reportMediaRepository.findById(reportMediaFileId);
    if (!mediaFile || mediaFile.reportId !== reportId) {
      throw new Error("Report media file not found");
    }

    await reportMediaRepository.softDelete(reportMediaFileId);

    const updated = await reportRepository.findById(reportId);
    return toReportResponse(updated!);
  }

  /**
   * Ban a report (moderation). Admin-only; sets status to rejected/banned.
   */
  async adminBanReport(id: string): Promise<ReportResponse> {
    const existing = await reportRepository.findById(id);
    if (!existing) {
      throw new Error("Report not found");
    }

    if (existing.status === REPORT_STATUS_BANNED) {
      return toReportResponse(existing);
    }

    const report = await reportRepository.update(id, {
      status: REPORT_STATUS_BANNED,
    });
    return toReportResponse(report);
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
      throw new Error("Report not found");
    }

    this.assertReporterMayEditReport(existing, userId, role);

    await reportRepository.softDelete(id);
  }

  async getUserReports(userId: string): Promise<ReportResponse[]> {
    const reports = await reportRepository.findByUserId(userId);
    return reports.map((r) => toReportResponse(r));
  }

  async searchReports(
    query: ReportSearchQuery,
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

      return {
        reports: reports.map((r) => toReportResponse(r, r.distance)),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      };
    }

    // Otherwise, use standard search
    const { reports, total } = await reportRepository.search(query);

    return {
      reports: reports.map((r) => toReportResponse(r)),
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
  ): Promise<ReportResponse> {
    const existing = await reportRepository.findById(id);
    if (!existing) {
      throw new Error("Report not found");
    }

    const report = await reportRepository.update(id, { status });
    return toReportResponse(report);
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
