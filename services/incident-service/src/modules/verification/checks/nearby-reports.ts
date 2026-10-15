import prisma from "../../../config/prisma.client";
import { REPORT_STATUS_REJECTED } from "../../../constants/report-verification";
import type { VerificationContext } from "./check-runner";

export interface NearbyReport {
  reportId: string;
  distanceM: number;
}

/**
 * Reports of the same category close in space and time: shown to the user as "support the
 * existing report". Evidence only, never part of the score (specs/006 FR-022).
 */
export async function findNearbyReports(ctx: VerificationContext): Promise<NearbyReport[]> {
  const { id, latitude, longitude, category, createdAt } = ctx.report;
  if (latitude == null || longitude == null) return [];
  const { nearbyRadiusM, nearbyHours } = ctx.checksConfig.duplicate;
  const since = new Date(createdAt.getTime() - nearbyHours * 3600_000);

  const rows = await prisma.$queryRaw<{ id: string; d: number }[]>`
    SELECT id, ST_Distance(location, ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography) AS d
    FROM reports
    WHERE id <> ${id}::uuid
      AND deleted_at IS NULL
      AND status <> ${REPORT_STATUS_REJECTED}
      AND category = ${category}::"ReportCategory"
      AND created_at >= ${since}
      AND ST_DWithin(location, ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography, ${nearbyRadiusM})
    ORDER BY d
    LIMIT 10`;
  return rows.map((r) => ({ reportId: r.id, distanceM: Math.round(Number(r.d)) }));
}
