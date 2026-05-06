import type { Request, Response } from "express";
import { HTTP_STATUS, sendError, sendSuccess } from "../../constants/http-status";
import type { MetricColumnDto, MetricTableDto } from "./metrics.dto";
import type { MetricColumnRow, MetricTableRow } from "./metric-metadata.service";
import { metricMetadataService } from "./metric-metadata.service";

function mapTableRow(r: MetricTableRow): MetricTableDto {
  return {
    id: r.id,
    key: r.key,
    label: r.label,
    description: r.description ?? null,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function mapColumnRow(r: MetricColumnRow): MetricColumnDto {
  return {
    id: r.id,
    tableId: r.tableId,
    metricTableKey: r.table.key,
    metricTableLabel: r.table.label,
    key: r.key,
    label: r.label,
    valueType: r.valueType,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function getMetricTables(req: Request, res: Response): Promise<void> {
  try {
    const label =
      typeof req.query.label === "string" ? req.query.label : undefined;
    const rows = await metricMetadataService.listTables({ label });
    sendSuccess(res, HTTP_STATUS.OK, {
      tables: rows.map(mapTableRow),
    });
  } catch (e) {
    console.error("getMetricTables", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function getMetricColumns(req: Request, res: Response): Promise<void> {
  try {
    const label =
      typeof req.query.label === "string" ? req.query.label : undefined;
    const metricTableId =
      typeof req.query.metricTableId === "string"
        ? req.query.metricTableId
        : undefined;

    const rows = await metricMetadataService.listColumns({
      label,
      metricTableId,
    });
    sendSuccess(res, HTTP_STATUS.OK, {
      columns: rows.map(mapColumnRow),
    });
  } catch (e) {
    console.error("getMetricColumns", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}
