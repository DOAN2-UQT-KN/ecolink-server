-- specs/012: ContextCheck reads an OpenStreetMap copy in PostGIS instead of Goong.
-- osm.context_features is created by `npm run osm:import` (scripts/osm/finalize.ts), outside Prisma:
-- a separate schema keeps `prisma migrate dev` from treating it as drift.
CREATE SCHEMA IF NOT EXISTS osm;

DROP TABLE IF EXISTS "geo_context_cache";

CREATE TABLE "osm_imports" (
    "id" UUID NOT NULL,
    "data_at" TIMESTAMP(3) NOT NULL,
    "style_version" VARCHAR(32) NOT NULL,
    "row_counts" JSONB NOT NULL,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "osm_imports_pkey" PRIMARY KEY ("id")
);
-- At most one active import (not expressible in Prisma).
CREATE UNIQUE INDEX "osm_imports_one_active" ON "osm_imports"("active") WHERE "active";

-- Rules on OSM feature classes (design doc "ContextCheck"); starting values, to be calibrated on real reports.
INSERT INTO "verification_configs" ("id", "key", "version", "value", "is_active") VALUES
(uuid_generate_v4(), 'category-rules', 'category-rules@2.0.0',
 '{"rules":{"WATERWAY":{"kind":"NEAR_FEATURE","classes":["waterway"],"maxDistanceM":80,"missRisk":0.4},"BEACH":{"kind":"NEAR_FEATURE","classes":["beach"],"maxDistanceM":150,"missRisk":0.5},"MARKET":{"kind":"NEAR_FEATURE","classes":["market"],"maxDistanceM":100,"missRisk":0.35,"requireCoverage":true},"SCHOOL":{"kind":"NEAR_FEATURE","classes":["school"],"maxDistanceM":100,"missRisk":0.35,"requireCoverage":true},"PARK":{"kind":"NEAR_FEATURE","classes":["park"],"maxDistanceM":50,"missRisk":0.4},"INDUSTRIAL_ZONE":{"kind":"NEAR_FEATURE","classes":["industrial"],"maxDistanceM":300,"missRisk":0.4},"ALLEY":{"kind":"NEAR_FEATURE","classes":["alley"],"maxDistanceM":15,"missRisk":0.2,"requireCoverage":true},"STREET":{"kind":"NEAR_FEATURE","classes":["street"],"maxDistanceM":25,"missRisk":0.3},"ILLEGAL_DUMP":{"kind":"NONE"},"DRAIN":{"kind":"NONE"},"OPEN_BURNING":{"kind":"NONE"},"OTHER":{"kind":"NONE"}},"coverage":{"radiusM":300,"minPoi":15}}',
 false);

-- Derived from the active checks version so later activations (e.g. duplicate.web) are kept.
INSERT INTO "verification_configs" ("id", "key", "version", "value", "is_active")
SELECT uuid_generate_v4(), 'checks', 'checks@1.2.0',
  jsonb_set("value", '{context}', jsonb_build_object(
    'version', 'context@2.0.0',
    'queryTimeoutMs', 1000,
    'suggestTimeoutMs', COALESCE("value"->'context'->'suggestTimeoutMs', '2000'::jsonb)
  )),
  false
FROM "verification_configs" WHERE "key" = 'checks' AND "is_active";

-- Switch: deactivate first, the partial unique index allows one active row per key.
UPDATE "verification_configs" SET "is_active" = false
WHERE "is_active" AND (("key" = 'category-rules' AND "version" <> 'category-rules@2.0.0') OR ("key" = 'checks' AND "version" <> 'checks@1.2.0'));
UPDATE "verification_configs" SET "is_active" = true
WHERE ("key" = 'category-rules' AND "version" = 'category-rules@2.0.0') OR ("key" = 'checks' AND "version" = 'checks@1.2.0');
