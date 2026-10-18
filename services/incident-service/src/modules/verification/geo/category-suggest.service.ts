import type { ReportCategory } from "@prisma/client";
import { HttpError, HTTP_STATUS } from "../../../constants/http-status";
import { contextEnabled } from "../checks/context.check";
import { verificationConfigService } from "../verification-config.service";
import type { FeatureClass } from "../verification-config.types";
import { judgeFit, searchRadiusM, type NearFeatureRule } from "./category-fit";
import { osmContextSource, type OsmContextSource } from "./osm-context.source";

export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

/**
 * Categories that fit a pinned point, for the report form (specs/012 US4). Same rules and data as
 * ContextCheck, one query for every class. Only a hint: 503 when off, without OSM data, failing or
 * slower than `suggestTimeoutMs`. Categories that need coverage in a sparsely mapped area are left out.
 */
export async function suggestCategories(lat: number, lng: number, source: OsmContextSource = osmContextSource) {
  if (!contextEnabled()) throw new HttpError(HTTP_STATUS.CONTEXT_UNAVAILABLE);

  const [{ version: rulesVersion, value: rulesCfg }, { value: checks }] = await Promise.all([
    verificationConfigService.get("category-rules"),
    verificationConfigService.get("checks"),
  ]);
  const { queryTimeoutMs, suggestTimeoutMs } = checks.context;
  const rules = (Object.entries(rulesCfg.rules) as [ReportCategory, (typeof rulesCfg.rules)[ReportCategory]][]).filter(
    (entry): entry is [ReportCategory, NearFeatureRule] => entry[1].kind === "NEAR_FEATURE",
  );
  const classes = [...new Set(rules.flatMap(([, rule]) => rule.classes))] as FeatureClass[];
  const searchM = Math.max(...rules.map(([, rule]) => searchRadiusM(rule)));

  const lookup = async () => {
    const data = await source.activeImport();
    const perClass = await source.nearestPerClass(classes, lat, lng, searchM, queryTimeoutMs);
    const foundFor = (rule: NearFeatureRule) =>
      perClass.filter((f) => rule.classes.includes(f.class as FeatureClass)).sort((a, b) => a.distanceM - b.distanceM);
    const needsCoverage = rules.some(([, rule]) => rule.requireCoverage && !(foundFor(rule)[0]?.distanceM <= rule.maxDistanceM));
    const poi = needsCoverage ? await source.countPoi(lat, lng, rulesCfg.coverage.radiusM, queryTimeoutMs) : null;

    const suggestions = rules
      .map(([category, rule]) => ({ category, ...judgeFit(rule, foundFor(rule), poi, rulesCfg.coverage.minPoi) }))
      .filter((r) => r.verdict === "FIT" && r.nearest)
      .map((r) => ({ category: r.category, nearest: { name: r.nearest!.name, distanceM: r.nearest!.distanceM } }))
      .sort((a, b) => a.nearest.distanceM - b.nearest.distanceM);
    return { rulesVersion, osmDataAt: data.dataAt.toISOString(), attribution: OSM_ATTRIBUTION, suggestions };
  };

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      lookup(),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("suggestion timeout")), suggestTimeoutMs))),
    ]);
  } catch (err) {
    console.warn("[report] category suggestion failed:", err instanceof Error ? err.message : err);
    throw new HttpError(HTTP_STATUS.CONTEXT_UNAVAILABLE);
  } finally {
    clearTimeout(timer);
  }
}
