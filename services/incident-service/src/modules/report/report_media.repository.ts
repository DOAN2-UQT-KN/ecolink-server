import { PrismaClient, Prisma } from "@prisma/client";
import prisma from "../../config/prisma.client";

export class ReportMediaRepository {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = prisma;
  }

  async create(data: {
    reportId?: string;
    mediaId: string;
    uploadedBy?: string;
  }) {
    return this.prisma.reportMediaFile.create({
      data: {
        reportId: data.reportId,
        mediaId: data.mediaId,
        uploadedBy: data.uploadedBy,
      },
    });
  }

  async createMany(
    data: {
      reportId?: string;
      mediaId: string;
      uploadedBy?: string;
    }[],
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? this.prisma;
    return db.reportMediaFile.createMany({
      data: data.map((item) => ({
        reportId: item.reportId,
        mediaId: item.mediaId,
        uploadedBy: item.uploadedBy,
      })),
    });
  }

  async findByReportId(reportId: string) {
    return this.prisma.reportMediaFile.findMany({
      where: { reportId, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
  }

  async findById(id: string) {
    return this.prisma.reportMediaFile.findFirst({
      where: { id, deletedAt: null },
    });
  }

  /**
   * Report media rows visible to the viewer: non-deleted file + report,
   * parent report owned by viewer or admin-verified (`isVerify`); media row non-deleted.
   * (No Prisma relation from report_media_files → media — join in code.)
   */
  async findManyByIdsVisibleToViewer(ids: string[], viewerUserId: string) {
    if (ids.length === 0) {
      return [];
    }
    const files = await this.prisma.reportMediaFile.findMany({
      where: {
        id: { in: ids },
        deletedAt: null,
        report: {
          deletedAt: null,
          OR: [{ userId: viewerUserId }, { isVerify: true }],
        },
      },
      orderBy: { createdAt: "asc" },
    });
    if (files.length === 0) {
      return [];
    }
    const mediaIds = [...new Set(files.map((f) => f.mediaId))];
    const mediaRows = await this.prisma.media.findMany({
      where: { id: { in: mediaIds }, deletedAt: null },
      select: { id: true, url: true, type: true },
    });
    const mediaById = new Map(mediaRows.map((m) => [m.id, m]));
    return files
      .map((f) => {
        const media = mediaById.get(f.mediaId);
        if (!media) {
          return null;
        }
        return { ...f, media };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
  }

  async update(id: string, data: { mediaId?: string }) {
    return this.prisma.reportMediaFile.update({
      where: { id },
      data,
    });
  }

  async softDelete(id: string) {
    return this.prisma.reportMediaFile.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async softDeleteByReportId(reportId: string, tx?: Prisma.TransactionClient) {
    const db = tx ?? this.prisma;
    return db.reportMediaFile.updateMany({
      where: { reportId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }
}

// Singleton instance
export const reportMediaRepository = new ReportMediaRepository();
