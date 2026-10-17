/**
 * Report verification schema (specs/006, plan P01) against real Postgres + PostGIS:
 * category/wasteTypes defaults and CSV backfill, the location trigger, the
 * per-user idempotency key, and radius search on the indexed location column.
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma, resetTables } from "./setup/test-db";
import { reportRepository } from "../modules/report/report.repository";

// Same statement as migration 20261015100000_report_category_and_location.
const BACKFILL_WASTE_TYPES = Prisma.sql`
  UPDATE "reports" SET "waste_types" = ARRAY(
    SELECT DISTINCT upper(trim(x))::"WasteType"
    FROM unnest(string_to_array("waste_type", ',')) AS x
    WHERE upper(trim(x)) IN ('HOUSEHOLD', 'CONSTRUCTION', 'INDUSTRIAL', 'HAZARDOUS')
  ) WHERE "waste_type" IS NOT NULL`;

async function locationOf(id: string): Promise<{ lat: number | null; lng: number | null }> {
  const [row] = await prisma.$queryRaw<{ lat: number | null; lng: number | null }[]>`
    SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng FROM reports WHERE id = ${id}::uuid`;
  return row;
}

describe("[it] report verification schema (P01)", () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("defaults category to OTHER and wasteTypes to []", async () => {
    const r = await prisma.report.create({ data: { userId: randomUUID(), title: "t" } });
    expect(r.category).toBe("OTHER");
    expect(r.wasteTypes).toEqual([]);
  });

  it("backfills wasteTypes from the CSV column and drops unknown values", async () => {
    const a = await prisma.report.create({ data: { title: "a", wasteType: "household, construction" } });
    const b = await prisma.report.create({ data: { title: "b", wasteType: "abc" } });
    await prisma.$executeRaw(BACKFILL_WASTE_TYPES);

    const after = await prisma.report.findMany({ where: { id: { in: [a.id, b.id] } } });
    const byId = new Map(after.map((r) => [r.id, r.wasteTypes]));
    expect([...(byId.get(a.id) ?? [])].sort()).toEqual(["CONSTRUCTION", "HOUSEHOLD"]);
    expect(byId.get(b.id)).toEqual([]);
  });

  it("keeps location in sync with latitude/longitude", async () => {
    const r = await prisma.report.create({ data: { title: "t", latitude: 10.79, longitude: 106.68 } });
    expect(await locationOf(r.id)).toEqual({ lat: 10.79, lng: 106.68 });

    await prisma.report.update({ where: { id: r.id }, data: { latitude: 10.8, longitude: 106.7 } });
    expect(await locationOf(r.id)).toEqual({ lat: 10.8, lng: 106.7 });

    await prisma.report.update({ where: { id: r.id }, data: { latitude: null } });
    expect(await locationOf(r.id)).toEqual({ lat: null, lng: null });
  });

  it("makes the idempotency key unique per user only", async () => {
    const userId = randomUUID();
    await prisma.report.create({ data: { userId, title: "1", idempotencyKey: "k1" } });
    await expect(
      prisma.report.create({ data: { userId, title: "2", idempotencyKey: "k1" } }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      prisma.report.create({ data: { userId: randomUUID(), title: "3", idempotencyKey: "k1" } }),
    ).resolves.toBeDefined();
  });

  it("radius search uses location and returns category/wasteTypes", async () => {
    // ~1 km and ~5 km north of the query point.
    const near = await prisma.report.create({
      data: { title: "near", latitude: 10.009, longitude: 106.0, category: "MARKET", wasteTypes: ["HOUSEHOLD"] },
    });
    await prisma.report.create({ data: { title: "far", latitude: 10.045, longitude: 106.0 } });

    const { reports, total } = await reportRepository.searchWithDistance(10.0, 106.0, {
      maxDistance: 2000,
    } as Parameters<typeof reportRepository.searchWithDistance>[2]);

    expect(total).toBe(1);
    expect(reports[0].id).toBe(near.id);
    expect(reports[0].category).toBe("MARKET");
    expect(reports[0].wasteTypes).toEqual(["HOUSEHOLD"]);
    expect(reports[0].distance).toBeGreaterThan(900);
    expect(reports[0].distance).toBeLessThan(1100);
  });

  it("radius filter can use the GiST index", async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      const plan = await tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
        `EXPLAIN SELECT id FROM reports
         WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint(106.0, 10.0), 4326)::geography, 2000)`,
      );
      expect(plan.map((r) => r["QUERY PLAN"]).join("\n")).toContain("reports_location_gist");
    });
  });
});
