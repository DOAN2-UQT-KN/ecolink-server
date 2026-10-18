import { verificationConfigService } from "../verification-config.service";
import { fittingCategories, judgeFit, searchRadiusM } from "../geo/category-fit";
import { osmContextSource, type OsmContextSource } from "../geo/osm-context.source";
import { notAvailableResult, type CheckRunner } from "./check-runner";

/** How many fitting categories a MISMATCH names (admin card + owner issue). */
const MAX_SUGGESTED = 3;

export const contextEnabled = (): boolean => process.env.CONTEXT_CHECK_ENABLED === "true";

/**
 * Does the chosen category fit the place (specs/012)? Measures the distance from the report to the
 * real geometry of OSM features of the rule's classes, in PostGIS; no external call. Category and
 * location both come from the client, so the weight stays low (0.1). Query errors, a timeout or no
 * active import propagate and become a FAILED check; the engine then re-normalises the weights.
 */
export function createContextCheck(source: OsmContextSource = osmContextSource): CheckRunner {
  const check: CheckRunner = {
    name: "CONTEXT",
    signalNames: ["category_fit"],
    version: (cfg) => cfg.context.version,
    async run(ctx) {
      const cfg = ctx.checksConfig;
      if (!contextEnabled()) return notAvailableResult(check, cfg);

      const { version: rulesVersion, value: rulesCfg } = await verificationConfigService.get("category-rules");
      const { category, latitude, longitude } = ctx.report;
      const rule = rulesCfg.rules[category] ?? { kind: "NONE" };
      const base = { check: "CONTEXT" as const, version: cfg.context.version, durationMs: 0 };
      const skipped = (evidence: Record<string, unknown>) => ({
        ...base,
        status: "SKIPPED" as const,
        risk: null,
        reasons: [],
        signals: [{ name: "category_fit", status: "SKIPPED" as const, risk: null }],
        evidence,
      });

      if (rule.kind === "NONE" || latitude == null || longitude == null) {
        return skipped({ category, rule: rule.kind, rulesVersion });
      }

      const timeoutMs = cfg.context.queryTimeoutMs;
      const started = Date.now();
      const data = await source.activeImport();
      const found = await source.nearest(rule.classes, latitude, longitude, searchRadiusM(rule), timeoutMs);
      const fitsRadius = !!found[0] && found[0].distanceM <= rule.maxDistanceM;
      const { radiusM, minPoi } = rulesCfg.coverage;
      const poi = !fitsRadius && rule.requireCoverage ? await source.countPoi(latitude, longitude, radiusM, timeoutMs) : null;
      const { verdict, nearest } = judgeFit(rule, found, poi, minPoi);

      // Which category would fit here; a hint only, so a failure here never fails the check.
      let suggestedCategories: { category: string; nearest: { name: string | null; distance_m: number } }[] | null = null;
      if (verdict === "MISMATCH") {
        try {
          suggestedCategories = (await fittingCategories(source, rulesCfg, latitude, longitude, timeoutMs))
            .filter((c) => c.category !== category)
            .slice(0, MAX_SUGGESTED)
            .map((c) => ({ category: c.category, nearest: { name: c.nearest.name, distance_m: c.nearest.distanceM } }));
        } catch (err) {
          console.warn("[context] suggested categories failed:", err instanceof Error ? err.message : err);
        }
      }

      const evidence = {
        category,
        rule: rule.kind,
        rulesVersion,
        verdict,
        nearest: nearest
          ? { name: nearest.name, class: nearest.class, tag: nearest.tag, osm: nearest.osm, distance_m: nearest.distanceM }
          : null,
        candidatesChecked: found.length,
        coverage: poi === null ? null : { poi, radiusM },
        ...(verdict === "MISMATCH" ? { suggestedCategories } : {}),
        osmDataAt: data.dataAt.toISOString(),
        styleVersion: data.styleVersion,
        queryMs: Date.now() - started,
      };
      if (verdict === "SPARSE_DATA") return skipped(evidence);

      const risk = verdict === "FIT" ? 0 : rule.missRisk;
      return {
        ...base,
        status: "COMPLETED",
        risk,
        reasons: verdict === "MISMATCH" ? ["CTX_CATEGORY_LOCATION_MISMATCH"] : [],
        signals: [{ name: "category_fit", status: "COMPLETED", risk, raw: nearest?.distanceM ?? null }],
        evidence,
      };
    },
  };
  return check;
}

export const contextCheck = createContextCheck();
