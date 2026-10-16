import { verificationConfigService } from "../verification-config.service";
import { judgeFit } from "../geo/category-fit";
import { findEvidence, geoDeps } from "../geo/geo-context.service";
import { notAvailableResult, type CheckRunner } from "./check-runner";

export const contextEnabled = (): boolean => process.env.CONTEXT_CHECK_ENABLED === "true";

/**
 * Does the chosen category fit the place (specs/006 P08)? Measures consistency only: category and
 * location both come from the client, so the weight stays low (0.1). Goong errors propagate and
 * become a FAILED check; the engine then re-normalises the weights.
 */
export const contextCheck: CheckRunner = {
  name: "CONTEXT",
  signalNames: ["category_fit"],
  version: (cfg) => cfg.context.version,
  async run(ctx, signal) {
    const cfg = ctx.checksConfig;
    if (!contextEnabled()) return notAvailableResult(contextCheck, cfg);

    const { version: rulesVersion, value: rules } = await verificationConfigService.get("category-rules");
    const { category, latitude, longitude } = ctx.report;
    const rule = rules[category] ?? { kind: "NONE" };
    const base = { check: "CONTEXT" as const, version: cfg.context.version, durationMs: 0 };

    if (rule.kind === "NONE" || latitude == null || longitude == null) {
      return {
        ...base,
        status: "SKIPPED",
        risk: null,
        reasons: [],
        signals: [{ name: "category_fit", status: "SKIPPED", risk: null }],
        evidence: { category, rule: rule.kind, rulesVersion },
      };
    }

    const goongSignal = AbortSignal.any([signal, AbortSignal.timeout(cfg.context.goongTimeoutMs)]);
    const found = await findEvidence(rule, category, rulesVersion, latitude, longitude, goongSignal, geoDeps(cfg.context.cacheTtlDays));
    const { verdict, nearest } = judgeFit(rule, found.evidence);
    const risk = verdict === "FIT" ? 0 : rule.missRisk;

    return {
      ...base,
      status: "COMPLETED",
      risk,
      reasons: verdict === "MISMATCH" ? ["CTX_CATEGORY_LOCATION_MISMATCH"] : [],
      signals: [{ name: "category_fit", status: "COMPLETED", risk, raw: nearest?.distanceM ?? null }],
      evidence: {
        category,
        rule: rule.kind,
        rulesVersion,
        verdict,
        nearest: nearest
          ? { name: nearest.name, keyword: nearest.keyword, distance_m: nearest.distanceM, source: nearest.source }
          : null,
        candidatesChecked: found.evidence.length,
        goongCalls: found.goongCalls,
        cacheHit: found.cacheHit,
      },
    };
  },
};
