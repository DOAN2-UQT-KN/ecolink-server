/**
 * Shape of the OSM context table (specs/012 data-model). Created by scripts/osm/finalize.ts outside
 * Prisma (schema `osm`, so `prisma migrate dev` ignores it); tests build the same table from here.
 */
export const OSM_SCHEMA = "osm";
export const CONTEXT_FEATURES = `${OSM_SCHEMA}.context_features`;
export const STYLE_VERSION = "osm-context@1.0.0";
export const FEATURE_CLASSES = [
  "waterway",
  "beach",
  "market",
  "school",
  "park",
  "industrial",
  "alley",
  "street",
  "poi",
] as const;

/** `table` is schema-qualified, e.g. "osm.context_features_next". Index names derive from the table name. */
export function contextFeaturesDdl(table: string): { create: string; indexes: string[] } {
  const base = table.split(".").pop() as string;
  return {
    create: `CREATE TABLE ${table} (
      class text NOT NULL,
      name text,
      tag text NOT NULL,
      osm_type char(1) NOT NULL CHECK (osm_type IN ('n', 'w', 'r')),
      osm_id bigint NOT NULL,
      geog geography NOT NULL
    )`,
    indexes: [
      `CREATE INDEX ${base}_geog_idx ON ${table} USING GIST (geog)`,
      `CREATE INDEX ${base}_class_idx ON ${table} (class)`,
    ],
  };
}
