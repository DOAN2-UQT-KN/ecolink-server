import type { Prisma, PrismaClient } from "@prisma/client";
import { CONTEXT_FEATURES, contextFeaturesDdl, FEATURE_CLASSES, OSM_SCHEMA, STYLE_VERSION } from "./osm-schema";

const IMPORT_TABLE = `${OSM_SCHEMA}.context_import`;
const NEXT_TABLE = `${OSM_SCHEMA}.context_features_next`;
/** A new import is refused when any class loses more than this share of rows (specs/012 FR-010). */
export const MAX_CLASS_DROP = 0.1;

export type RowCounts = Record<(typeof FEATURE_CLASSES)[number], number>;

/**
 * Turns the raw osm2pgsql output (osm.context_import) into the table ContextCheck reads, in one
 * transaction: geography + indexes, row-count guard against the active import, rename, OsmImport row.
 * Readers keep seeing the previous table until the commit. Throws (nothing changes) when the guard fails.
 */
export async function finalizeImport(db: PrismaClient, dataAt: Date): Promise<RowCounts> {
  return db.$transaction(
    async (tx) => {
      const [{ n }] = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${IMPORT_TABLE}`);
      if (Number(n) === 0) throw new Error(`${IMPORT_TABLE} is empty`);

      const ddl = contextFeaturesDdl(NEXT_TABLE);
      await tx.$executeRawUnsafe(`DROP TABLE IF EXISTS ${NEXT_TABLE}`);
      await tx.$executeRawUnsafe(ddl.create);
      await tx.$executeRawUnsafe(
        `INSERT INTO ${NEXT_TABLE} (class, name, tag, osm_type, osm_id, geog)
         SELECT class, name, tag, lower(osm_type), osm_id, geom::geography FROM ${IMPORT_TABLE}`,
      );

      const counted = await tx.$queryRawUnsafe<{ class: string; n: bigint }[]>(
        `SELECT class, count(*) AS n FROM ${NEXT_TABLE} GROUP BY class`,
      );
      const rowCounts = Object.fromEntries(FEATURE_CLASSES.map((c) => [c, 0])) as RowCounts;
      for (const row of counted) {
        if (row.class in rowCounts) rowCounts[row.class as keyof RowCounts] = Number(row.n);
      }

      const active = await tx.osmImport.findFirst({ where: { active: true } });
      if (active) {
        const previous = active.rowCounts as Partial<RowCounts>;
        for (const c of FEATURE_CLASSES) {
          const before = previous[c] ?? 0;
          if (rowCounts[c] < before * (1 - MAX_CLASS_DROP)) {
            throw new Error(`class ${c} dropped from ${before} to ${rowCounts[c]} rows; keeping the active import`);
          }
        }
      }

      // Indexes after the bulk insert: much faster than maintaining them row by row.
      for (const sql of ddl.indexes) await tx.$executeRawUnsafe(sql);
      await tx.$executeRawUnsafe(`DROP TABLE IF EXISTS ${CONTEXT_FEATURES}`);
      await tx.$executeRawUnsafe(`ALTER TABLE ${NEXT_TABLE} RENAME TO context_features`);
      await tx.$executeRawUnsafe(`ALTER INDEX ${OSM_SCHEMA}.context_features_next_geog_idx RENAME TO context_features_geog_idx`);
      await tx.$executeRawUnsafe(`ALTER INDEX ${OSM_SCHEMA}.context_features_next_class_idx RENAME TO context_features_class_idx`);

      await tx.osmImport.updateMany({ where: { active: true }, data: { active: false } });
      await tx.osmImport.create({
        data: { dataAt, styleVersion: STYLE_VERSION, rowCounts: rowCounts as Prisma.InputJsonValue, active: true },
      });
      await tx.$executeRawUnsafe(`DROP TABLE ${IMPORT_TABLE}`);
      return rowCounts;
    },
    { timeout: 60 * 60_000, maxWait: 60_000 },
  );
}
