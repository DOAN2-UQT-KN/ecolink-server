import type { FitRule } from "../verification-config.types";
import type { OsmFeature } from "./osm-context.source";

export type NearFeatureRule = Extract<FitRule, { kind: "NEAR_FEATURE" }>;
export type FitVerdict = "FIT" | "MISMATCH" | "SPARSE_DATA";

/**
 * FIT when the nearest feature of the rule's classes lies within its radius (0 inside an area).
 * Otherwise a rule that needs coverage gives SPARSE_DATA where the map holds fewer than `minPoi`
 * points (not mapped is not "not there"), else MISMATCH. `nearest` is kept even outside the radius,
 * so a moderator sees "nearest market 420 m away". `coveragePoi` is null when it was not counted.
 */
export function judgeFit(
  rule: NearFeatureRule,
  found: OsmFeature[],
  coveragePoi: number | null,
  minPoi: number,
): { verdict: FitVerdict; nearest: OsmFeature | null } {
  const nearest = found[0] ?? null;
  if (nearest && nearest.distanceM <= rule.maxDistanceM) return { verdict: "FIT", nearest };
  if (rule.requireCoverage && coveragePoi !== null && coveragePoi < minPoi) return { verdict: "SPARSE_DATA", nearest };
  return { verdict: "MISMATCH", nearest };
}

/** Search wider than the rule so a MISMATCH still names the nearest feature (design doc: 500 m). */
export const searchRadiusM = (rule: NearFeatureRule) => Math.max(rule.maxDistanceM, 500);
