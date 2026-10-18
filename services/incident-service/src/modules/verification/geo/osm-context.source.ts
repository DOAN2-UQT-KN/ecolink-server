import { Prisma, type PrismaClient } from "@prisma/client";
import prisma from "../../../config/prisma.client";
import type { FeatureClass } from "../verification-config.types";
import { CONTEXT_FEATURES } from "./osm-schema";

/** No active import, or osm.context_features is missing: ContextCheck is FAILED, suggestions 503. */
export class OsmDataUnavailable extends Error {
  constructor(message = "no active OSM context import") {
    super(message);
    this.name = "OsmDataUnavailable";
  }
}

export interface OsmFeature {
  name: string | null;
  class: string;
  tag: string;
  /** "node/1", "way/2", "relation/3": the object's page is https://www.openstreetmap.org/<osm>. */
  osm: string;
  distanceM: number;
}

export interface OsmImportInfo {
  dataAt: Date;
  styleVersion: string;
}

/** The adapter ContextCheck and the category suggestions read OSM data through (specs/012 R4). */
export interface OsmContextSource {
  activeImport(): Promise<OsmImportInfo>;
  /** Up to 5 nearest features of `classes` within `searchM`, closest first. */
  nearest(classes: FeatureClass[], lat: number, lng: number, searchM: number, timeoutMs: number): Promise<OsmFeature[]>;
  /** The nearest feature of each class within `searchM`. */
  nearestPerClass(classes: FeatureClass[], lat: number, lng: number, searchM: number, timeoutMs: number): Promise<OsmFeature[]>;
  /** Amenity/shop points within `radiusM`: how densely the area is mapped. */
  countPoi(lat: number, lng: number, radiusM: number, timeoutMs: number): Promise<number>;
}

const OSM_TYPES: Record<string, string> = { n: "node", w: "way", r: "relation" };
const IMPORT_CACHE_MS = 60_000;
const STALE_MS = 30 * 86_400_000;
const STALE_WARN_EVERY_MS = 3_600_000;

type Row = { class: string; name: string | null; tag: string; osm_type: string; osm_id: bigint; distance_m: number };

const toFeature = (r: Row): OsmFeature => ({
  name: r.name,
  class: r.class,
  tag: r.tag,
  osm: `${OSM_TYPES[r.osm_type.trim()] ?? r.osm_type}/${r.osm_id}`,
  distanceM: Math.round(r.distance_m),
});

const isMissingTable = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError
    ? err.code === "P2010" && String(err.meta?.code) === "42P01"
    : /relation .* does not exist/.test(String((err as Error)?.message));

export function createOsmContextSource(db: PrismaClient = prisma): OsmContextSource {
  let cached: { at: number; info: OsmImportInfo } | null = null;
  let warnedAt = 0;

  /** `statement_timeout` stops a slow query in Postgres itself, not only in Node. */
  async function query<T>(timeoutMs: number, sql: Prisma.Sql): Promise<T[]> {
    try {
      const [, rows] = await db.$transaction([
        db.$executeRawUnsafe(`SET LOCAL statement_timeout = ${Math.max(1, Math.round(timeoutMs))}`),
        db.$queryRaw<T[]>(sql),
      ]);
      return rows;
    } catch (err) {
      if (isMissingTable(err)) throw new OsmDataUnavailable(`${CONTEXT_FEATURES} does not exist`);
      throw err;
    }
  }

  const point = (lat: number, lng: number) => Prisma.sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`;
  const table = Prisma.raw(CONTEXT_FEATURES);

  return {
    async activeImport() {
      if (cached && Date.now() - cached.at < IMPORT_CACHE_MS) return cached.info;
      const row = await db.osmImport.findFirst({ where: { active: true } });
      if (!row) throw new OsmDataUnavailable();
      const info = { dataAt: row.dataAt, styleVersion: row.styleVersion };
      cached = { at: Date.now(), info };
      if (Date.now() - info.dataAt.getTime() > STALE_MS && Date.now() - warnedAt > STALE_WARN_EVERY_MS) {
        warnedAt = Date.now();
        console.warn(`[context] OSM data is older than 30 days (${info.dataAt.toISOString()}); run npm run osm:import`);
      }
      return info;
    },

    async nearest(classes, lat, lng, searchM, timeoutMs) {
      const rows = await query<Row>(
        timeoutMs,
        Prisma.sql`SELECT class, name, tag, osm_type, osm_id, ST_Distance(geog, p.pt) AS distance_m
          FROM ${table}, (SELECT ${point(lat, lng)} AS pt) p
          WHERE class = ANY(${classes}::text[]) AND ST_DWithin(geog, p.pt, ${searchM})
          ORDER BY distance_m LIMIT 5`,
      );
      return rows.map(toFeature);
    },

    async nearestPerClass(classes, lat, lng, searchM, timeoutMs) {
      const rows = await query<Row>(
        timeoutMs,
        Prisma.sql`SELECT DISTINCT ON (class) class, name, tag, osm_type, osm_id, ST_Distance(geog, p.pt) AS distance_m
          FROM ${table}, (SELECT ${point(lat, lng)} AS pt) p
          WHERE class = ANY(${classes}::text[]) AND ST_DWithin(geog, p.pt, ${searchM})
          ORDER BY class, distance_m`,
      );
      return rows.map(toFeature);
    },

    async countPoi(lat, lng, radiusM, timeoutMs) {
      const [row] = await query<{ n: bigint }>(
        timeoutMs,
        Prisma.sql`SELECT count(*) AS n FROM ${table}
          WHERE class = 'poi' AND ST_DWithin(geog, ${point(lat, lng)}, ${radiusM})`,
      );
      return Number(row?.n ?? 0);
    },
  };
}

export const osmContextSource = createOsmContextSource();
