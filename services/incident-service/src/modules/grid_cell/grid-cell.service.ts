import { Prisma } from "@prisma/client";
import { SHIFT_RESULT_REPORT_STATUS } from "@da2/constants";
import prisma from "../../config/prisma.client";
import { resolveCellOutcome } from "./grid-cell-outcome";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

/** Cell size in metres. Part of the key ("100:x:y"), so changing it never mixes old and new cells. */
export const GRID_SIZE_M = 100;

/**
 * Cell keys (the ones the DB trigger writes to reports.grid_key) deduplicated, without nulls.
 */
export function distinctCellKeys(keys: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(keys.filter((k): k is string => !!k))];
}

/**
 * Recompute the counters of these cells from the source of truth (reports and grid_cell_cleanups),
 * creating the cell when it does not exist. Idempotent, so a missed or repeated call never drifts:
 * call it after anything that changes a cell (report created, verified, banned, moved; cleanup recorded).
 */
export async function refreshCells(db: Db, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  await db.$executeRaw`
    INSERT INTO "grid_cells" ("cell_key", "grid_size_m", "cell_x", "cell_y", "center_lat", "center_lng",
                              "submitted_count", "verified_count", "last_report_at",
                              "cleanup_count", "last_cleaned_at", "updated_at")
    SELECT k.key,
           split_part(k.key, ':', 1)::int,
           split_part(k.key, ':', 2)::bigint,
           split_part(k.key, ':', 3)::bigint,
           ST_Y(c.pt), ST_X(c.pt),
           COALESCE(r.submitted, 0), COALESCE(r.verified, 0), r.last_at,
           COALESCE(cl.cnt, 0), cl.last_at,
           now()
    FROM unnest(${keys as string[]}::text[]) AS k(key)
    CROSS JOIN LATERAL (
      SELECT ST_Transform(ST_SetSRID(ST_MakePoint(
        (split_part(k.key, ':', 2)::bigint + 0.5) * split_part(k.key, ':', 1)::int,
        (split_part(k.key, ':', 3)::bigint + 0.5) * split_part(k.key, ':', 1)::int), 32648), 4326) AS pt
    ) c
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS submitted,
             (count(*) FILTER (WHERE "is_verify"))::int AS verified,
             max("created_at") AS last_at
      FROM "reports" WHERE "grid_key" = k.key AND "deleted_at" IS NULL
    ) r ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS cnt, max("cleaned_at") AS last_at
      FROM "grid_cell_cleanups" WHERE "cell_key" = k.key
    ) cl ON true
    ON CONFLICT ("cell_key") DO UPDATE SET
      "submitted_count" = EXCLUDED."submitted_count",
      "verified_count" = EXCLUDED."verified_count",
      "last_report_at" = EXCLUDED."last_report_at",
      "cleanup_count" = EXCLUDED."cleanup_count",
      "last_cleaned_at" = EXCLUDED."last_cleaned_at",
      "updated_at" = now()`;
}

/** Cells of these reports (their grid_key is set by the DB trigger), then refresh them. */
export async function refreshCellsOfReports(db: Db, reportIds: readonly string[]): Promise<void> {
  if (reportIds.length === 0) return;
  const rows = await db.report.findMany({
    where: { id: { in: [...reportIds] } },
    select: { gridKey: true },
  });
  await refreshCells(db, distinctCellKeys(rows.map((r) => r.gridKey)));
}

/**
 * Record the cleaning of a campaign: one row per (cell, shift), written when the completion is
 * approved but dated at the end of the shift (when the trash was really removed). Safe to re-run.
 */
export async function recordCampaignCleanups(tx: Tx, campaignId: string): Promise<void> {
  // CampaignShiftResultReport has no relation to Report, so the cell comes from a second query.
  const handled = await tx.campaignShiftResultReport.findMany({
    where: {
      result: { campaignId, reopenedAt: null },
      status: { in: [SHIFT_RESULT_REPORT_STATUS.CLEANED, SHIFT_RESULT_REPORT_STATUS.PARTIAL] },
    },
    select: {
      reportId: true,
      status: true,
      result: { select: { shiftId: true, shift: { select: { endAt: true, endedAt: true } } } },
    },
  });
  const reports = await tx.report.findMany({
    where: { id: { in: handled.map((h) => h.reportId) }, gridKey: { not: null } },
    select: { id: true, gridKey: true },
  });
  const cellOf = new Map(reports.map((r) => [r.id, r.gridKey as string]));

  const groups = new Map<string, { cellKey: string; shiftId: string; cleanedAt: Date; statuses: string[] }>();
  for (const row of handled) {
    const cellKey = cellOf.get(row.reportId);
    if (!cellKey) continue;
    const { shiftId, shift } = row.result;
    const id = `${cellKey}|${shiftId}`;
    const group = groups.get(id) ?? {
      cellKey,
      shiftId,
      cleanedAt: shift.endedAt ?? shift.endAt,
      statuses: [],
    };
    group.statuses.push(row.status);
    groups.set(id, group);
  }
  if (groups.size === 0) return;

  const keys = distinctCellKeys([...groups.values()].map((g) => g.cellKey));
  // Cleanups reference the cell, so the cells exist before their rows.
  await refreshCells(tx, keys);
  await tx.gridCellCleanup.createMany({
    data: [...groups.values()].map((g) => ({
      cellKey: g.cellKey,
      campaignId,
      shiftId: g.shiftId,
      cleanedAt: g.cleanedAt,
      outcome: resolveCellOutcome(g.statuses),
      reportCount: g.statuses.length,
    })),
    skipDuplicates: true,
  });
  await refreshCells(tx, keys);
}

/** Recompute every cell from scratch (admin repair after a bulk change or a bug). */
export async function recomputeAllCells(): Promise<number> {
  const rows = await prisma.$queryRaw<{ key: string }[]>`
    SELECT DISTINCT "grid_key" AS key FROM "reports" WHERE "grid_key" IS NOT NULL
    UNION SELECT "cell_key" FROM "grid_cells"`;
  const keys = rows.map((r) => r.key);
  for (let i = 0; i < keys.length; i += 500) {
    await refreshCells(prisma, keys.slice(i, i + 500));
  }
  return keys.length;
}
