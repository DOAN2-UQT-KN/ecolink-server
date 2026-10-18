import { judgeFit, searchRadiusM, type NearFeatureRule } from "../geo/category-fit";
import type { OsmFeature } from "../geo/osm-context.source";

const WATERWAY: NearFeatureRule = { kind: "NEAR_FEATURE", classes: ["waterway"], maxDistanceM: 80, missRisk: 0.4 };
const SCHOOL: NearFeatureRule = { kind: "NEAR_FEATURE", classes: ["school"], maxDistanceM: 100, missRisk: 0.35, requireCoverage: true };
const feature = (distanceM: number, cls = "waterway"): OsmFeature => ({
  name: "Kênh Nhiêu Lộc", class: cls, tag: "waterway=canal", osm: "way/1", distanceM,
});

describe("judgeFit (specs/012)", () => {
  it("is FIT within the radius, on the radius and inside an area", () => {
    expect(judgeFit(WATERWAY, [feature(35)], null, 15).verdict).toBe("FIT");
    expect(judgeFit(WATERWAY, [feature(80)], null, 15).verdict).toBe("FIT");
    expect(judgeFit(WATERWAY, [feature(0)], null, 15)).toEqual({ verdict: "FIT", nearest: feature(0) });
  });

  it("is MISMATCH outside the radius and keeps the nearest feature", () => {
    expect(judgeFit(WATERWAY, [feature(420)], null, 15)).toEqual({ verdict: "MISMATCH", nearest: feature(420) });
    expect(judgeFit(WATERWAY, [], null, 15)).toEqual({ verdict: "MISMATCH", nearest: null });
  });

  it("gives SPARSE_DATA only for a coverage rule in a sparsely mapped area", () => {
    expect(judgeFit(SCHOOL, [], 3, 15).verdict).toBe("SPARSE_DATA");
    expect(judgeFit(SCHOOL, [feature(300, "school")], 14, 15).verdict).toBe("SPARSE_DATA");
    expect(judgeFit(SCHOOL, [], 15, 15).verdict).toBe("MISMATCH");
    expect(judgeFit(SCHOOL, [feature(50, "school")], 0, 15).verdict).toBe("FIT");
    expect(judgeFit(WATERWAY, [], 0, 15).verdict).toBe("MISMATCH");
  });

  it("searches at least 500 m so a MISMATCH names the nearest feature", () => {
    expect(searchRadiusM(WATERWAY)).toBe(500);
    expect(searchRadiusM({ ...WATERWAY, maxDistanceM: 1500 })).toBe(1500);
  });
});
