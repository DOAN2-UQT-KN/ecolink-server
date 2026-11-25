import { Prisma } from "@prisma/client";
import prisma from "../../config/prisma.client";
import { HttpError, HTTP_STATUS } from "../../constants/http-status";
import { recomputeAllCells } from "./grid-cell.service";

export type GridCellSort = "submitted" | "verified" | "last_report" | "last_cleaned" | "cleanup";

const ORDER: Record<GridCellSort, Prisma.GridCellOrderByWithRelationInput> = {
  submitted: { submittedCount: "desc" },
  verified: { verifiedCount: "desc" },
  last_report: { lastReportAt: { sort: "desc", nulls: "last" } },
  last_cleaned: { lastCleanedAt: { sort: "desc", nulls: "last" } },
  cleanup: { cleanupCount: "desc" },
};

function toCell(c: {
  cellKey: string;
  gridSizeM: number;
  centerLat: number;
  centerLng: number;
  submittedCount: number;
  verifiedCount: number;
  lastReportAt: Date | null;
  cleanupCount: number;
  lastCleanedAt: Date | null;
}) {
  return {
    cellKey: c.cellKey,
    gridSizeM: c.gridSizeM,
    centerLat: c.centerLat,
    centerLng: c.centerLng,
    submittedCount: c.submittedCount,
    verifiedCount: c.verifiedCount,
    lastReportAt: c.lastReportAt,
    cleanupCount: c.cleanupCount,
    lastCleanedAt: c.lastCleanedAt,
  };
}

export const gridCellAdminService = {
  async list(input: {
    sort: GridCellSort;
    minReports: number;
    maxReports?: number;
    onlyCleaned: boolean;
    page: number;
    limit: number;
  }) {
    const where: Prisma.GridCellWhereInput = {
      submittedCount: {
        gte: input.minReports,
        ...(input.maxReports !== undefined ? { lte: input.maxReports } : {}),
      },
      ...(input.onlyCleaned ? { cleanupCount: { gt: 0 } } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.gridCell.findMany({
        where,
        orderBy: [ORDER[input.sort], { cellKey: "asc" }],
        skip: (input.page - 1) * input.limit,
        take: input.limit,
      }),
      prisma.gridCell.count({ where }),
    ]);
    return {
      items: rows.map(toCell),
      total,
      page: input.page,
      limit: input.limit,
      totalPages: Math.ceil(total / input.limit),
    };
  },

  async getByKey(cellKey: string) {
    const cell = await prisma.gridCell.findUnique({ where: { cellKey } });
    if (!cell) throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Grid cell not found"));
    const [reports, cleanups] = await Promise.all([
      prisma.report.findMany({
        where: { gridKey: cellKey, deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: { id: true, title: true, status: true, isVerify: true, severityLevel: true, createdAt: true },
      }),
      prisma.gridCellCleanup.findMany({
        where: { cellKey },
        orderBy: { cleanedAt: "desc" },
        select: { id: true, campaignId: true, shiftId: true, cleanedAt: true, outcome: true, reportCount: true },
      }),
    ]);
    return { cell: toCell(cell), reports, cleanups };
  },

  /** Repair after a bulk change: rebuilds every counter from reports and cleanup rows. */
  async recompute() {
    return { cells: await recomputeAllCells() };
  },
};
