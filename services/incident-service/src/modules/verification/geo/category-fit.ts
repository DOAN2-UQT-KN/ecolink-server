import type { ReportCategory } from "@prisma/client";
import type { CategoryRulesConfig, FeatureClass, FitRule } from "../verification-config.types";
import type { OsmContextSource, OsmFeature } from "./osm-context.source";

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

export interface FittingCategory {
  category: ReportCategory;
  nearest: { name: string | null; distanceM: number };
}

/**
 * Every category whose rule is a FIT at the point, nearest first: one query for all classes, plus a
 * coverage count only when a coverage rule found nothing in range. Used by the form suggestions and,
 * on a MISMATCH, by ContextCheck to tell which category would fit (specs/012).
 */
export async function fittingCategories(
  source: OsmContextSource,
  rulesCfg: CategoryRulesConfig,
  lat: number,
  lng: number,
  timeoutMs: number,
): Promise<FittingCategory[]> {
  const rules = (Object.entries(rulesCfg.rules) as [ReportCategory, FitRule][]).filter(
    (entry): entry is [ReportCategory, NearFeatureRule] => entry[1].kind === "NEAR_FEATURE",
  );
  if (!rules.length) return [];
  const classes = [...new Set(rules.flatMap(([, rule]) => rule.classes))] as FeatureClass[];
  const searchM = Math.max(...rules.map(([, rule]) => searchRadiusM(rule)));

  const perClass = await source.nearestPerClass(classes, lat, lng, searchM, timeoutMs);
  const foundFor = (rule: NearFeatureRule) =>
    perClass.filter((f) => rule.classes.includes(f.class as FeatureClass)).sort((a, b) => a.distanceM - b.distanceM);
  const needsCoverage = rules.some(([, rule]) => rule.requireCoverage && !(foundFor(rule)[0]?.distanceM <= rule.maxDistanceM));
  const poi = needsCoverage ? await source.countPoi(lat, lng, rulesCfg.coverage.radiusM, timeoutMs) : null;

  return rules
    .map(([category, rule]) => ({ category, ...judgeFit(rule, foundFor(rule), poi, rulesCfg.coverage.minPoi) }))
    .flatMap((r) => (r.verdict === "FIT" && r.nearest ? [{ category: r.category, nearest: { name: r.nearest.name, distanceM: r.nearest.distanceM } }] : []))
    .sort((a, b) => a.nearest.distanceM - b.nearest.distanceM);
}
