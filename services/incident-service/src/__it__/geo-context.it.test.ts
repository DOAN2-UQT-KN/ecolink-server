/**
 * ContextCheck lookups (specs/006, plan P08) against real Postgres with a fake Goong:
 * per-cell cache, rules-version keys, expiry, street filtering, Detail cap and suggestions.
 */
// suggestCategories uses the default client: replace it with a fake market 50 m from MARKET_AT.
jest.mock("../modules/verification/geo/goong.client", () => {
  const near = { lat: 10.77253 + 50 / 111_320, lng: 106.69803 };
  return {
    goongClient: {
      autocomplete: async () => [{ placeId: "m", mainText: "Chợ Bến Thành", description: "Chợ Bến Thành" }],
      placeDetail: async () => ({ name: "Chợ Bến Thành", ...near }),
      geocode: async (lat: number, lng: number) => ({ name: "45 Lê Lợi, Quận 1", lat, lng }),
    },
  };
});

import { Prisma } from "@prisma/client";
import { prisma } from "./setup/test-db";
import { findEvidence, type GeoDeps } from "../modules/verification/geo/geo-context.service";
import { suggestCategories } from "../modules/verification/geo/category-suggest.service";
import { HttpError } from "../constants/http-status";
import type { GoongClient } from "../modules/verification/geo/goong.client";
import type { FitRule } from "../modules/verification/verification-config.types";
import { geohashCellCenter, geohashEncode } from "../utils/geo";

const MARKET: FitRule = { kind: "NEARBY_PLACE", keywords: ["chợ"], maxDistanceM: 150, missRisk: 0.5 };
const V1 = "category-rules@1.0.0";
// Chợ Bến Thành-ish; two points ~100 m apart inside the same 7-char cell are picked below.
const MARKET_AT = { lat: 10.77253, lng: 106.69803 };

function fakeGoong(predictionNames: string[] = ["Chợ Bến Thành"]) {
  const calls = { autocomplete: 0, placeDetail: 0, geocode: 0 };
  const goong: GoongClient = {
    async autocomplete() {
      calls.autocomplete++;
      return predictionNames.map((mainText, i) => ({ placeId: `p${i}`, mainText, description: mainText }));
    },
    async placeDetail(placeId) {
      calls.placeDetail++;
      return { name: predictionNames[Number(placeId.slice(1))], ...MARKET_AT };
    },
    async geocode(lat, lng) {
      calls.geocode++;
      return { name: "12 Lê Lợi, Quận 1", lat, lng };
    },
  };
  return { goong, calls };
}

const deps = (goong: GoongClient, now = new Date()): GeoDeps => ({ goong, db: prisma, now: () => now, cacheTtlDays: 30 });
const signal = () => new AbortController().signal;

describe("[it] geo context cache (P08)", () => {
  beforeEach(async () => {
    await prisma.$executeRaw(Prisma.sql`TRUNCATE TABLE "geo_context_cache"`);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("second lookup in the same cell is served from cache", async () => {
    const { goong, calls } = fakeGoong();
    const first = await findEvidence(MARKET, "MARKET", V1, 10.7726, 106.6981, signal(), deps(goong));
    expect(first.goongCalls).toBe(2);
    expect(first.cacheHit).toBe(false);
    expect(await prisma.geoContextCache.count()).toBe(1);

    const second = await findEvidence(MARKET, "MARKET", V1, 10.7726, 106.6981, signal(), deps(goong));
    expect(second).toMatchObject({ goongCalls: 0, cacheHit: true });
    expect(second.evidence).toEqual(first.evidence);
    expect(calls.autocomplete).toBe(1);
  });

  it("measures distance from each report's own point", async () => {
    const { goong } = fakeGoong();
    // Two points 40 m either side of the centre of one 7-char cell (~153 m tall).
    const c = geohashCellCenter(geohashEncode(10.7726, 106.6981, 7));
    const dLat = 40 / 111_320;
    const a = await findEvidence(MARKET, "MARKET", V1, c.lat - dLat, c.lng, signal(), deps(goong));
    const b = await findEvidence(MARKET, "MARKET", V1, c.lat + dLat, c.lng, signal(), deps(goong));
    expect(b.cacheHit).toBe(true);
    expect(a.evidence[0].distanceM).not.toBe(b.evidence[0].distanceM);
  });

  it("a new rules version or an expired row bypasses the cache", async () => {
    const { goong, calls } = fakeGoong();
    await findEvidence(MARKET, "MARKET", V1, 10.7726, 106.6981, signal(), deps(goong));
    await findEvidence(MARKET, "MARKET", "category-rules@1.1.0", 10.7726, 106.6981, signal(), deps(goong));
    expect(calls.autocomplete).toBe(2);

    const later = new Date(Date.now() + 31 * 86_400_000);
    const again = await findEvidence(MARKET, "MARKET", V1, 10.7726, 106.6981, signal(), deps(goong, later));
    expect(again.cacheHit).toBe(false);
    expect(calls.autocomplete).toBe(3);
  });

  it("drops street names and caps Place Detail calls at 5", async () => {
    const names = ["Đường Chợ Lớn", "Chợ Bến Thành", "Chợ 2", "Chợ 3", "Chợ 4", "Chợ 5", "Chợ 6", "Chợ 7", "Chợ 8"];
    const { goong, calls } = fakeGoong(names);
    const r = await findEvidence(MARKET, "MARKET", V1, 10.7726, 106.6981, signal(), deps(goong));
    expect(calls.placeDetail).toBe(5);
    expect(r.evidence.map((e) => e.name)).not.toContain("Đường Chợ Lớn");
    expect(r.evidence[0].name).toBe("Chợ Bến Thành");
  });

  it("address rules geocode the report's point, cached per 8-char cell", async () => {
    const { goong, calls } = fakeGoong();
    const ALLEY: FitRule = { kind: "ADDRESS_PATTERN", patterns: ["/", "Hẻm"], missRisk: 0.3 };
    const r = await findEvidence(ALLEY, "ALLEY", V1, 10.7726, 106.6981, signal(), deps(goong));
    expect(r.evidence[0]).toMatchObject({ name: "12 Lê Lợi, Quận 1", distanceM: 0, source: "goong_geocode" });
    await findEvidence(ALLEY, "ALLEY", V1, 10.7726, 106.6981, signal(), deps(goong));
    expect(calls.geocode).toBe(1);
  });

  it("suggests the categories that fit, and is unavailable while disabled", async () => {
    const saved = process.env.CONTEXT_CHECK_ENABLED;
    try {
      process.env.CONTEXT_CHECK_ENABLED = "true";
      const out = await suggestCategories(MARKET_AT.lat, MARKET_AT.lng);
      expect(out.rulesVersion).toBe(V1);
      // STREET fits too (the fake geocode lands on the point itself) and comes first: closest first.
      expect(out.suggestions.map((x) => x.category).slice(0, 2)).toEqual(["STREET", "MARKET"]);
      expect(out.suggestions[1].nearest).toMatchObject({ name: "Chợ Bến Thành" });
      expect(out.suggestions.map((x) => x.category)).not.toContain("SCHOOL");

      process.env.CONTEXT_CHECK_ENABLED = "false";
      const err = await suggestCategories(MARKET_AT.lat, MARKET_AT.lng).catch((e: unknown) => e);
      expect(err instanceof HttpError && err.statusResponse.code).toBe("CONTEXT_UNAVAILABLE");
    } finally {
      process.env.CONTEXT_CHECK_ENABLED = saved;
    }
  });
});
