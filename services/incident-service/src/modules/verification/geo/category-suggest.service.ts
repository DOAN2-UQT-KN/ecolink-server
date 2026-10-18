import { HttpError, HTTP_STATUS } from "../../../constants/http-status";
import { contextEnabled } from "../checks/context.check";
import { verificationConfigService } from "../verification-config.service";
import { fittingCategories } from "./category-fit";
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

  const lookup = async () => {
    const data = await source.activeImport();
    const suggestions = await fittingCategories(source, rulesCfg, lat, lng, queryTimeoutMs);
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
