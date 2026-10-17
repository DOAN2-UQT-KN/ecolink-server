import type { ReportCategory } from "@prisma/client";
import { HttpError, HTTP_STATUS } from "../../../constants/http-status";
import { geohashEncode } from "../../../utils/geo";
import { contextEnabled } from "../checks/context.check";
import { verificationConfigService } from "../verification-config.service";
import { judgeFit } from "./category-fit";
import { findEvidence, geoDeps } from "./geo-context.service";

/** Lookups still running at the deadline carry on in the background to warm the cache for the next call. */
const BACKGROUND_TIMEOUT_MS = 30_000;

/**
 * Categories that fit a pinned point, for the report form (specs/006 FR-031). Same rules and cache
 * as ContextCheck. Only a hint: returns the categories whose lookup finished by `suggestTimeoutMs`
 * (one failing or slow category does not hide the others); 503 only when none finished.
 */
export async function suggestCategories(lat: number, lng: number) {
  if (!contextEnabled()) throw new HttpError(HTTP_STATUS.CONTEXT_UNAVAILABLE);

  const [{ version: rulesVersion, value: rules }, { value: checks }] = await Promise.all([
    verificationConfigService.get("category-rules"),
    verificationConfigService.get("checks"),
  ]);
  const signal = AbortSignal.timeout(BACKGROUND_TIMEOUT_MS);
  const deps = geoDeps(checks.context.cacheTtlDays);

  const done: { category: ReportCategory; verdict: string; nearest: { name: string; distanceM: number | null } | null }[] = [];
  const lookups = (Object.entries(rules) as [ReportCategory, (typeof rules)[ReportCategory]][])
    .filter(([, rule]) => rule.kind !== "NONE")
    .map(([category, rule]) =>
      findEvidence(rule, category, rulesVersion, lat, lng, signal, deps).then(
        ({ evidence }) => void done.push({ category, ...judgeFit(rule, evidence) }),
        (err) => console.warn(`[report] category suggestion ${category} failed:`, err instanceof Error ? err.message : err),
      ),
    );
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(lookups),
    new Promise((resolve) => (timer = setTimeout(resolve, checks.context.suggestTimeoutMs))),
  ]);
  clearTimeout(timer);
  if (!done.length) throw new HttpError(HTTP_STATUS.CONTEXT_UNAVAILABLE);

  const suggestions = done
    .filter((r) => r.verdict === "FIT")
    .map((r) => ({ category: r.category, nearest: r.nearest ? { name: r.nearest.name, distanceM: r.nearest.distanceM } : null }))
    .sort((a, b) => (a.nearest?.distanceM ?? Infinity) - (b.nearest?.distanceM ?? Infinity));
  return { cellId: geohashEncode(lat, lng, 7), rulesVersion, suggestions };
}
