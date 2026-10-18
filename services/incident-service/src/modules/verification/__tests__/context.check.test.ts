jest.mock("../verification-config.service", () => ({
  verificationConfigService: {
    get: jest.fn().mockResolvedValue({
      version: "category-rules@2.0.0",
      value: {
        rules: {
          WATERWAY: { kind: "NEAR_FEATURE", classes: ["waterway"], maxDistanceM: 80, missRisk: 0.4 },
          MARKET: { kind: "NEAR_FEATURE", classes: ["market"], maxDistanceM: 100, missRisk: 0.35, requireCoverage: true },
          SCHOOL: { kind: "NEAR_FEATURE", classes: ["school"], maxDistanceM: 100, missRisk: 0.35, requireCoverage: true },
          DRAIN: { kind: "NONE" },
        },
        coverage: { radiusM: 300, minPoi: 15 },
      },
    }),
  },
}));

import { createContextCheck } from "../checks/context.check";
import type { VerificationContext } from "../checks/check-runner";
import { OsmDataUnavailable, type OsmContextSource, type OsmFeature } from "../geo/osm-context.source";
import type { ChecksConfig } from "../verification-config.types";

const cfg = { context: { version: "context@2.0.0", queryTimeoutMs: 1000, suggestTimeoutMs: 2000 } } as ChecksConfig;
const ctx = (over: Partial<VerificationContext["report"]> = {}): VerificationContext => ({
  report: { id: "r1", userId: "u1", category: "WATERWAY", latitude: 10.79, longitude: 106.69, createdAt: new Date(), ...over },
  media: [],
  attempt: 1,
  checksConfig: cfg,
});
const DATA_AT = new Date("2026-10-11T20:21:00Z");
const feature = (distanceM: number, cls: string, osm = "way/123"): OsmFeature => ({
  name: cls === "waterway" ? "Kênh Nhiêu Lộc" : "Chợ Tân Định", class: cls, tag: `${cls}=x`, osm, distanceM,
});

function source(found: OsmFeature[], poi = 20): jest.Mocked<OsmContextSource> {
  return {
    activeImport: jest.fn().mockResolvedValue({ dataAt: DATA_AT, styleVersion: "osm-context@1.0.0" }),
    nearest: jest.fn().mockResolvedValue(found),
    nearestPerClass: jest.fn(),
    countPoi: jest.fn().mockResolvedValue(poi),
  };
}
const run = (s: OsmContextSource, c = ctx()) => createContextCheck(s).run(c, new AbortController().signal);

describe("contextCheck on OSM (specs/012)", () => {
  const saved = process.env.CONTEXT_CHECK_ENABLED;
  beforeEach(() => (process.env.CONTEXT_CHECK_ENABLED = "true"));
  afterAll(() => (process.env.CONTEXT_CHECK_ENABLED = saved));

  it("is NOT_AVAILABLE while the flag is off", async () => {
    process.env.CONTEXT_CHECK_ENABLED = "false";
    const s = source([]);
    expect((await run(s)).status).toBe("NOT_AVAILABLE");
    expect(s.activeImport).not.toHaveBeenCalled();
  });

  it("skips NONE rules and reports without coordinates without querying", async () => {
    const s = source([]);
    expect((await run(s, ctx({ category: "DRAIN" }))).status).toBe("SKIPPED");
    expect((await run(s, ctx({ latitude: null }))).status).toBe("SKIPPED");
    expect(s.nearest).not.toHaveBeenCalled();
  });

  it("is FIT next to a canal, with the OSM evidence", async () => {
    const s = source([feature(35, "waterway")]);
    const r = await run(s);
    expect(r).toMatchObject({ status: "COMPLETED", risk: 0, reasons: [] });
    expect(r.signals[0]).toMatchObject({ name: "category_fit", status: "COMPLETED", risk: 0, raw: 35 });
    expect(r.evidence).toMatchObject({
      verdict: "FIT",
      rulesVersion: "category-rules@2.0.0",
      nearest: { name: "Kênh Nhiêu Lộc", class: "waterway", osm: "way/123", distance_m: 35 },
      candidatesChecked: 1,
      coverage: null,
      osmDataAt: DATA_AT.toISOString(),
      styleVersion: "osm-context@1.0.0",
    });
    expect(s.nearest).toHaveBeenCalledWith(["waterway"], 10.79, 106.69, 500, 1000);
    expect(s.countPoi).not.toHaveBeenCalled();
  });

  it("is MISMATCH for a market 420 m away in a well-mapped area", async () => {
    const r = await run(source([feature(420, "market", "node/9")], 20), ctx({ category: "MARKET" }));
    expect(r).toMatchObject({ status: "COMPLETED", risk: 0.35, reasons: ["CTX_CATEGORY_LOCATION_MISMATCH"] });
    expect(r.evidence).toMatchObject({ verdict: "MISMATCH", coverage: { poi: 20, radiusM: 300 }, nearest: { osm: "node/9", distance_m: 420 } });
  });

  it("is SKIPPED with SPARSE_DATA for a school where the map is thin", async () => {
    const s = source([], 3);
    const r = await run(s, ctx({ category: "SCHOOL" }));
    expect(r).toMatchObject({ status: "SKIPPED", risk: null, reasons: [] });
    expect(r.signals[0]).toMatchObject({ status: "SKIPPED" });
    expect(r.evidence).toMatchObject({ verdict: "SPARSE_DATA", coverage: { poi: 3, radiusM: 300 }, nearest: null });
    expect(s.countPoi).toHaveBeenCalledWith(10.79, 106.69, 300, 1000);
  });

  it("rejects without OSM data so the runner records FAILED", async () => {
    const s = source([]);
    s.activeImport.mockRejectedValue(new OsmDataUnavailable());
    await expect(run(s)).rejects.toBeInstanceOf(OsmDataUnavailable);
  });
});
