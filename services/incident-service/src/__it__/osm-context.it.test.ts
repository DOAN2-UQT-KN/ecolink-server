/**
 * OSM context data (specs/012) against real PostGIS: the import swap and its row-count guard, the
 * distance queries to real geometries, ContextCheck verdicts and the category suggestions.
 * osm2pgsql is not run here: rows are inserted in osm.context_import / osm.context_features directly.
 */
import { prisma } from "./setup/test-db";
import { createContextCheck } from "../modules/verification/checks/context.check";
import type { VerificationContext } from "../modules/verification/checks/check-runner";
import { suggestCategories } from "../modules/verification/geo/category-suggest.service";
import { finalizeImport } from "../modules/verification/geo/osm-import";
import { createOsmContextSource, OsmDataUnavailable } from "../modules/verification/geo/osm-context.source";
import { CONTEXT_FEATURES, contextFeaturesDdl } from "../modules/verification/geo/osm-schema";
import { verificationConfigService } from "../modules/verification/verification-config.service";
import { HttpError } from "../constants/http-status";

const M_PER_DEG = 111_320;
const CANAL = { lat: 10.79, lng1: 106.68, lng2: 106.69 };
const PARK = { lat: 10.8, lng: 106.7, half: 0.00045 }; // ~100 m x 100 m
const MARKET = { lat: 10.77, lng: 106.7 };
const EMPTY = { lat: 10.85, lng: 106.75 };

const north = (lat: number, metres: number) => lat + metres / M_PER_DEG;
const parkWkt = () => {
  const { lat, lng, half: h } = PARK;
  return `POLYGON((${lng - h} ${lat - h}, ${lng + h} ${lat - h}, ${lng + h} ${lat + h}, ${lng - h} ${lat + h}, ${lng - h} ${lat - h}))`;
};

type Row = { cls: string; name: string | null; tag: string; type: string; id: number; wkt: string };
const baseRows = (poi = 20): Row[] => [
  { cls: "waterway", name: "Kênh Nhiêu Lộc", tag: "waterway=canal", type: "W", id: 101, wkt: `LINESTRING(${CANAL.lng1} ${CANAL.lat}, ${CANAL.lng2} ${CANAL.lat})` },
  { cls: "park", name: "Công viên Tao Đàn", tag: "leisure=park", type: "W", id: 102, wkt: parkWkt() },
  { cls: "market", name: "Chợ Tân Định", tag: "amenity=marketplace", type: "N", id: 103, wkt: `POINT(${MARKET.lng} ${MARKET.lat})` },
  ...Array.from({ length: poi }, (_, i) => ({
    cls: "poi", name: null, tag: "shop=convenience", type: "N", id: 1000 + i,
    wkt: `POINT(${MARKET.lng + (i % 5) * 0.0003} ${north(MARKET.lat, 40 + Math.floor(i / 5) * 30)})`,
  })),
];

async function resetOsm() {
  await prisma.osmImport.deleteMany();
  await prisma.$executeRawUnsafe("DROP TABLE IF EXISTS osm.context_import, osm.context_features, osm.context_features_next");
}

async function fillImportTable(rows: Row[]) {
  await prisma.$executeRawUnsafe("DROP TABLE IF EXISTS osm.context_import");
  await prisma.$executeRawUnsafe(
    "CREATE TABLE osm.context_import (osm_type char(1) NOT NULL, osm_id bigint NOT NULL, class text NOT NULL, name text, tag text NOT NULL, geom geometry(Geometry,4326) NOT NULL)",
  );
  for (const r of rows) {
    await prisma.$executeRaw`INSERT INTO osm.context_import (osm_type, osm_id, class, name, tag, geom)
      VALUES (${r.type}, ${r.id}, ${r.cls}, ${r.name}, ${r.tag}, ST_GeomFromText(${r.wkt}, 4326))`;
  }
}

/** Active data straight into osm.context_features (what a finished import leaves behind). */
async function seedFeatures(rows: Row[], dataAt = new Date()) {
  await resetOsm();
  const ddl = contextFeaturesDdl(CONTEXT_FEATURES);
  await prisma.$executeRawUnsafe(ddl.create);
  for (const sql of ddl.indexes) await prisma.$executeRawUnsafe(sql);
  for (const r of rows) {
    await prisma.$executeRaw`INSERT INTO osm.context_features (class, name, tag, osm_type, osm_id, geog)
      VALUES (${r.cls}, ${r.name}, ${r.tag}, ${r.type.toLowerCase()}, ${r.id}, ST_GeomFromText(${r.wkt}, 4326)::geography)`;
  }
  await prisma.osmImport.create({ data: { dataAt, styleVersion: "osm-context@1.0.0", rowCounts: {}, active: true } });
}

const ctx = (category: VerificationContext["report"]["category"], lat: number, lng: number, checksConfig: VerificationContext["checksConfig"]): VerificationContext => ({
  report: { id: "r1", userId: "u1", category, latitude: lat, longitude: lng, createdAt: new Date() },
  media: [],
  attempt: 1,
  checksConfig,
});

describe("[it] OSM context (specs/012)", () => {
  const savedFlag = process.env.CONTEXT_CHECK_ENABLED;
  beforeAll(() => {
    process.env.CONTEXT_CHECK_ENABLED = "true";
    verificationConfigService.clearCache();
  });
  afterAll(async () => {
    process.env.CONTEXT_CHECK_ENABLED = savedFlag;
    await resetOsm();
    await prisma.$disconnect();
  });

  describe("finalizeImport", () => {
    beforeEach(resetOsm);

    it("activates the first import with per-class row counts and drops the raw table", async () => {
      await fillImportTable(baseRows(20));
      const counts = await finalizeImport(prisma, new Date("2026-10-11T20:21:00Z"));

      expect(counts).toMatchObject({ waterway: 1, park: 1, market: 1, poi: 20, school: 0 });
      const active = await prisma.osmImport.findMany({ where: { active: true } });
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ styleVersion: "osm-context@1.0.0", dataAt: new Date("2026-10-11T20:21:00Z") });
      const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>("SELECT count(*) AS n FROM osm.context_features");
      expect(Number(n)).toBe(23);
      const [{ t }] = await prisma.$queryRawUnsafe<{ t: string | null }[]>("SELECT to_regclass('osm.context_import')::text AS t");
      expect(t).toBeNull();
    });

    it("refuses an import where a class drops more than 10% and keeps the active data", async () => {
      await fillImportTable(baseRows(20));
      await finalizeImport(prisma, new Date("2026-10-11T00:00:00Z"));
      const before = await prisma.osmImport.findFirstOrThrow({ where: { active: true } });

      await fillImportTable(baseRows(10));
      await expect(finalizeImport(prisma, new Date("2026-10-18T00:00:00Z"))).rejects.toThrow(/class poi dropped from 20 to 10/);

      expect((await prisma.osmImport.findFirstOrThrow({ where: { active: true } })).id).toBe(before.id);
      const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>("SELECT count(*) AS n FROM osm.context_features WHERE class = 'poi'");
      expect(Number(n)).toBe(20);
    });

    it("accepts a small drop and leaves exactly one active import", async () => {
      await fillImportTable(baseRows(20));
      await finalizeImport(prisma, new Date("2026-10-11T00:00:00Z"));
      await fillImportTable(baseRows(19));
      await finalizeImport(prisma, new Date("2026-10-18T00:00:00Z"));

      const active = await prisma.osmImport.findMany({ where: { active: true } });
      expect(active).toHaveLength(1);
      expect(active[0].dataAt).toEqual(new Date("2026-10-18T00:00:00Z"));
      expect(await prisma.osmImport.count()).toBe(2);
    });
  });

  describe("osmContextSource", () => {
    beforeAll(() => seedFeatures(baseRows(20)));

    it("measures to the line of a canal and is 0 inside a park", async () => {
      const source = createOsmContextSource(prisma);
      const [canal] = await source.nearest(["waterway"], north(CANAL.lat, 35), 106.685, 500, 1000);
      expect(canal).toMatchObject({ name: "Kênh Nhiêu Lộc", class: "waterway", tag: "waterway=canal", osm: "way/101" });
      expect(canal.distanceM).toBeGreaterThanOrEqual(30);
      expect(canal.distanceM).toBeLessThanOrEqual(40);

      const [park] = await source.nearest(["park"], PARK.lat, PARK.lng, 500, 1000);
      expect(park).toMatchObject({ osm: "way/102", distanceM: 0 });
    });

    it("returns one nearest feature per class and counts poi", async () => {
      const source = createOsmContextSource(prisma);
      const perClass = await source.nearestPerClass(["waterway", "park", "market"], MARKET.lat, MARKET.lng, 5000, 1000);
      expect(perClass.map((f) => f.class).sort()).toEqual(["market", "park", "waterway"]);
      expect(perClass.find((f) => f.class === "market")).toMatchObject({ osm: "node/103", distanceM: 0 });

      expect(await source.countPoi(MARKET.lat, MARKET.lng, 300, 1000)).toBe(20);
      expect(await source.countPoi(EMPTY.lat, EMPTY.lng, 300, 1000)).toBe(0);
    });

    it("throws OsmDataUnavailable without an active import", async () => {
      await prisma.osmImport.updateMany({ data: { active: false } });
      try {
        await expect(createOsmContextSource(prisma).activeImport()).rejects.toBeInstanceOf(OsmDataUnavailable);
      } finally {
        await prisma.osmImport.updateMany({ data: { active: true } });
      }
    });
  });

  describe("contextCheck and suggestions on PostGIS", () => {
    beforeAll(() => seedFeatures(baseRows(20)));
    const check = () => createContextCheck(createOsmContextSource(prisma));
    const checksConfig = async () => (await verificationConfigService.get("checks")).value;

    it("concludes FIT, MISMATCH and SPARSE_DATA from the rules", async () => {
      const cfg = await checksConfig();
      const signal = new AbortController().signal;

      const fit = await check().run(ctx("WATERWAY", north(CANAL.lat, 35), 106.685, cfg), signal);
      expect(fit).toMatchObject({ status: "COMPLETED", risk: 0, evidence: { verdict: "FIT", nearest: { osm: "way/101" } } });

      // SCHOOL: none mapped; around the market there are 20 poi (well mapped), in EMPTY none.
      const mismatch = await check().run(ctx("SCHOOL", MARKET.lat, MARKET.lng, cfg), signal);
      expect(mismatch).toMatchObject({ status: "COMPLETED", risk: 0.35, reasons: ["CTX_CATEGORY_LOCATION_MISMATCH"] });
      expect(mismatch.evidence).toMatchObject({ verdict: "MISMATCH", coverage: { poi: 20, radiusM: 300 } });
      // At the market the MARKET rule fits: that is the category to suggest.
      expect(mismatch.evidence.suggestedCategories).toEqual(
        expect.arrayContaining([{ category: "MARKET", nearest: { name: "Chợ Tân Định", distance_m: 0 } }]),
      );

      const sparse = await check().run(ctx("SCHOOL", EMPTY.lat, EMPTY.lng, cfg), signal);
      expect(sparse).toMatchObject({ status: "SKIPPED", risk: null, evidence: { verdict: "SPARSE_DATA", coverage: { poi: 0 } } });

      // WATERWAY needs no coverage: nothing nearby is a MISMATCH even where the map is empty.
      const noCanal = await check().run(ctx("WATERWAY", EMPTY.lat, EMPTY.lng, cfg), signal);
      expect(noCanal).toMatchObject({ status: "COMPLETED", risk: 0.4, evidence: { verdict: "MISMATCH" } });
    });

    it("suggests the categories that fit, nearest first, with the data date and attribution", async () => {
      const source = createOsmContextSource(prisma);
      const inPark = await suggestCategories(PARK.lat, PARK.lng, source);
      expect(inPark.suggestions[0]).toEqual({ category: "PARK", nearest: { name: "Công viên Tao Đàn", distanceM: 0 } });
      expect(inPark).toMatchObject({ rulesVersion: "category-rules@2.0.0", attribution: "© OpenStreetMap contributors" });
      expect(typeof inPark.osmDataAt).toBe("string");

      const byCanal = await suggestCategories(north(CANAL.lat, 35), 106.685, source);
      expect(byCanal.suggestions.map((s) => s.category)).toContain("WATERWAY");

      // MARKET needs coverage: the market itself is a FIT at its own point...
      const atMarket = await suggestCategories(MARKET.lat, MARKET.lng, source);
      expect(atMarket.suggestions.map((s) => s.category)).toContain("MARKET");
      // ...and an empty area suggests nothing rather than guessing.
      expect((await suggestCategories(EMPTY.lat, EMPTY.lng, source)).suggestions).toEqual([]);
    });

    it("answers 503 without OSM data", async () => {
      await prisma.osmImport.updateMany({ data: { active: false } });
      try {
        await expect(suggestCategories(PARK.lat, PARK.lng, createOsmContextSource(prisma))).rejects.toBeInstanceOf(HttpError);
      } finally {
        await prisma.osmImport.updateMany({ data: { active: true } });
      }
    });
  });
});
