import type { ReportCategory } from "@prisma/client";
import { HttpError, HTTP_STATUS } from "../../../constants/http-status";
import { geohashEncode } from "../../../utils/geo";
import { contextEnabled } from "../checks/context.check";
import { verificationConfigService } from "../verification-config.service";
import { judgeFit } from "./category-fit";
import { findEvidence, geoDeps } from "./geo-context.service";

/**
 * Categories that fit a pinned point, for the report form (specs/006 FR-031). Same rules and cache
 * as ContextCheck. Only a hint: any failure is 503 and the form shows the full list.
 */
export async function suggestCategories(lat: number, lng: number) {
  if (!contextEnabled()) throw new HttpError(HTTP_STATUS.CONTEXT_UNAVAILABLE);

  const [{ version: rulesVersion, value: rules }, { value: checks }] = await Promise.all([
    verificationConfigService.get("category-rules"),
    verificationConfigService.get("checks"),
  ]);
  const signal = AbortSignal.timeout(checks.context.suggestTimeoutMs);
  const deps = geoDeps(checks.context.cacheTtlDays);

  try {
    const results = await Promise.all(
      (Object.entries(rules) as [ReportCategory, (typeof rules)[ReportCategory]][])
        .filter(([, rule]) => rule.kind !== "NONE")
        .map(async ([category, rule]) => {
          const { evidence } = await findEvidence(rule, category, rulesVersion, lat, lng, signal, deps);
          return { category, ...judgeFit(rule, evidence) };
        }),
    );
    const suggestions = results
      .filter((r) => r.verdict === "FIT")
      .map((r) => ({ category: r.category, nearest: r.nearest ? { name: r.nearest.name, distanceM: r.nearest.distanceM } : null }))
      .sort((a, b) => (a.nearest?.distanceM ?? Infinity) - (b.nearest?.distanceM ?? Infinity));
    return { cellId: geohashEncode(lat, lng, 7), rulesVersion, suggestions };
  } catch (err) {
    console.warn("[report] category suggestions failed:", err instanceof Error ? err.message : err);
    throw new HttpError(HTTP_STATUS.CONTEXT_UNAVAILABLE);
  }
}
