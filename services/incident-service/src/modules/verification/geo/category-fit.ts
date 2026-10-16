import { normalizeVi } from "../../../utils/geo";
import type { FitRule } from "../verification-config.types";

export interface GeoEvidence {
  name: string;
  keyword: string | null;
  /** Null for address-based evidence (e.g. WATERWAY address hint): counts as a fit. */
  distanceM: number | null;
  source: "goong_place" | "goong_geocode";
}

const HOUSE_NUMBER_WITH_SLASH = /^\s*\d+[a-z]?\/\d+/;

function fits(rule: FitRule, e: GeoEvidence): boolean {
  switch (rule.kind) {
    case "NEARBY_PLACE":
      return e.distanceM === null || e.distanceM <= rule.maxDistanceM;
    case "ADDRESS_PATTERN": {
      const address = normalizeVi(e.name);
      return (
        HOUSE_NUMBER_WITH_SLASH.test(address) ||
        rule.patterns.some((p) => p !== "/" && address.includes(normalizeVi(p)))
      );
    }
    case "ON_STREET":
      // shortcut: "có tên đường" được hiểu là Geocode có kết quả trong bán kính; đổi sang kiểm address_components khi có dữ liệu thật (T151)
      return e.distanceM !== null && e.distanceM <= rule.maxDistanceM;
    default:
      return false;
  }
}

/**
 * FIT when some evidence satisfies the rule, MISMATCH otherwise. `nearest` is kept even when it
 * lies outside the radius, so a moderator sees "nearest market 900 m away" (specs/006 US5 AS2).
 */
export function judgeFit(rule: FitRule, evidence: GeoEvidence[]): { verdict: "FIT" | "MISMATCH"; nearest: GeoEvidence | null } {
  const matching = evidence.filter((e) => fits(rule, e));
  const fit = matching.length > 0;
  // FIT: address evidence (no distance) first; MISMATCH: the closest measured place first.
  const missing = fit ? -1 : Number.POSITIVE_INFINITY;
  const byDistance = (a: GeoEvidence, b: GeoEvidence) => (a.distanceM ?? missing) - (b.distanceM ?? missing);
  const nearest = [...(fit ? matching : evidence)].sort(byDistance)[0] ?? null;
  return { verdict: fit ? "FIT" : "MISMATCH", nearest };
}
