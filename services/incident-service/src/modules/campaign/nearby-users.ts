import { fetchUserIdsNearPoint } from "../organization/identity-user.client";
import { reportRepository } from "../report/report.repository";

/** Radius for inviting residents around a campaign (spec: 5 km). */
export const NEARBY_RESIDENT_RADIUS_METERS = 5_000;

/**
 * People around any of `points`: those whose saved location is within the radius, and those who
 * reported waste there. `excludeUserIds` are left out (compared case-insensitively).
 */
export async function findNearbyUserIds(
  points: Array<{ latitude: number; longitude: number }>,
  excludeUserIds: string[],
  radiusMeters = NEARBY_RESIDENT_RADIUS_METERS,
): Promise<string[]> {
  const exclude = new Set(excludeUserIds.map((id) => id?.toLowerCase().trim()).filter(Boolean));
  const found = await Promise.all(
    points.flatMap((p) => [
      fetchUserIdsNearPoint({
        latitude: p.latitude,
        longitude: p.longitude,
        radiusMeters,
        excludeUserIds: [...exclude],
      }),
      reportRepository.findDistinctReporterUserIdsNearPoint(p.longitude, p.latitude, radiusMeters),
    ]),
  );
  return [
    ...new Set(found.flat().filter((id) => id && !exclude.has(id.toLowerCase().trim()))),
  ];
}
