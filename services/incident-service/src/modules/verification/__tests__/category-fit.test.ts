import { judgeFit, type GeoEvidence } from "../geo/category-fit";
import type { FitRule } from "../verification-config.types";

const place = (name: string, distanceM: number | null): GeoEvidence => ({
  name,
  keyword: "chợ",
  distanceM,
  source: distanceM === null ? "goong_geocode" : "goong_place",
});
const MARKET: FitRule = { kind: "NEARBY_PLACE", keywords: ["chợ"], maxDistanceM: 150, missRisk: 0.5 };
const WATERWAY: FitRule = { kind: "NEARBY_PLACE", keywords: ["kênh"], maxDistanceM: 300, missRisk: 0.25, addressHints: ["Kênh"] };
const ALLEY: FitRule = { kind: "ADDRESS_PATTERN", patterns: ["/", "Hẻm", "Ngõ", "Kiệt"], missRisk: 0.3 };
const STREET: FitRule = { kind: "ON_STREET", maxDistanceM: 50, missRisk: 0.3 };

describe("judgeFit", () => {
  it("FIT when a market is within the radius", () => {
    expect(judgeFit(MARKET, [place("Chợ Bàn Cờ", 120), place("Chợ Xa", 900)])).toEqual({
      verdict: "FIT",
      nearest: place("Chợ Bàn Cờ", 120),
    });
  });

  it("MISMATCH keeps the nearest place even outside the radius", () => {
    const r = judgeFit(MARKET, [place("Chợ Xa", 900), place("Chợ Rất Xa", 1400)]);
    expect(r.verdict).toBe("MISMATCH");
    expect(r.nearest?.distanceM).toBe(900);
    expect(judgeFit(MARKET, [])).toEqual({ verdict: "MISMATCH", nearest: null });
  });

  it("an address hint counts as a fit for WATERWAY", () => {
    const r = judgeFit(WATERWAY, [place("Cầu Xa", 800), place("12 Kênh Tẻ, Quận 7", null)]);
    expect(r.verdict).toBe("FIT");
    expect(r.nearest?.distanceM).toBeNull();
  });

  it.each([
    ["123/45 Lê Văn Sỹ, Phường 13", "FIT"],
    ["Hẻm 12 Trường Sa, Quận 3", "FIT"],
    ["45 Trường Sa, Quận 3", "MISMATCH"],
  ])("ALLEY %s -> %s", (address, verdict) => {
    expect(judgeFit(ALLEY, [{ name: address, keyword: null, distanceM: 5, source: "goong_geocode" }]).verdict).toBe(verdict);
  });

  it.each([
    [30, "FIT"],
    [80, "MISMATCH"],
  ])("ON_STREET geocode %s m away -> %s", (distanceM, verdict) => {
    expect(judgeFit(STREET, [{ name: "Trường Sa", keyword: null, distanceM, source: "goong_geocode" }]).verdict).toBe(verdict);
  });
});
