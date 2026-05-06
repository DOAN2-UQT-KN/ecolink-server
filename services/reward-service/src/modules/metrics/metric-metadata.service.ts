import type { MetricColumn, MetricTable, Prisma } from "@prisma/client";
import prisma from "../../config/prisma.client";

export type MetricTableRow = Pick<
  MetricTable,
  "id" | "key" | "label" | "description" | "isActive" | "createdAt" | "updatedAt"
>;

export type MetricColumnRow = MetricColumn & {
  table: Pick<MetricTable, "key" | "label">;
};

export class MetricMetadataService {
  async listTables(opts: { label?: string }): Promise<MetricTableRow[]> {
    const label = opts.label?.trim();
    const where: Prisma.MetricTableWhereInput = {
      isActive: true,
      ...(label
        ? {
            label: { contains: label, mode: "insensitive" },
          }
        : {}),
    };
    return prisma.metricTable.findMany({
      where,
      orderBy: { key: "asc" },
      select: {
        id: true,
        key: true,
        label: true,
        description: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async listColumns(opts: {
    label?: string;
    metricTableId?: string;
  }): Promise<MetricColumnRow[]> {
    const label = opts.label?.trim();
    const where: Prisma.MetricColumnWhereInput = {
      isActive: true,
      ...(opts.metricTableId ? { tableId: opts.metricTableId } : {}),
      ...(label
        ? {
            label: { contains: label, mode: "insensitive" },
          }
        : {}),
    };
    return prisma.metricColumn.findMany({
      where,
      orderBy: [{ tableId: "asc" }, { key: "asc" }],
      include: {
        table: { select: { key: true, label: true } },
      },
    });
  }

  /**
   * Active tables keyed by logical `key`, each with a Set of active column keys.
   */
  async loadActiveMetricIndex(): Promise<Map<string, Set<string>>> {
    const rows = await prisma.metricTable.findMany({
      where: { isActive: true },
      select: {
        key: true,
        columns: {
          where: { isActive: true },
          select: { key: true },
        },
      },
    });
    const map = new Map<string, Set<string>>();
    for (const t of rows) {
      map.set(t.key, new Set(t.columns.map((c) => c.key)));
    }
    return map;
  }
}

export const metricMetadataService = new MetricMetadataService();
