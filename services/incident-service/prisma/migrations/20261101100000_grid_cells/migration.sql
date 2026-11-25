-- Grid cells (100 m): one row per cell for reports + cleanup history, used to predict where and when
-- trash comes back. grid_cells is a cache; reports (grid_key, created_at) and grid_cell_cleanups are
-- the source of truth and let the counters be recomputed.

-- A point maps to the cell holding it: UTM 48N (metres, <1% distortion over Vietnam), floored to the
-- grid so every point of a cell yields the same key. The size is part of the key so a resize never mixes cells.
CREATE OR REPLACE FUNCTION grid_cell_key(lat double precision, lng double precision, size_m integer DEFAULT 100)
RETURNS text AS $$
  SELECT size_m::text || ':' || floor(ST_X(p) / size_m)::bigint || ':' || floor(ST_Y(p) / size_m)::bigint
  FROM (SELECT ST_Transform(ST_SetSRID(ST_MakePoint(lng, lat), 4326), 32648) AS p) s
$$ LANGUAGE sql IMMUTABLE STRICT;

-- AlterTable
ALTER TABLE "reports" ADD COLUMN "grid_key" VARCHAR(48);

-- grid_key follows latitude/longitude (also when a report is edited), like "location".
CREATE OR REPLACE FUNCTION reports_sync_grid_key() RETURNS trigger AS $$
BEGIN
  NEW."grid_key" := grid_cell_key(NEW."latitude", NEW."longitude");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "reports_sync_grid_key"
BEFORE INSERT OR UPDATE OF "latitude", "longitude" ON "reports"
FOR EACH ROW EXECUTE FUNCTION reports_sync_grid_key();

UPDATE "reports" SET "grid_key" = grid_cell_key("latitude", "longitude")
WHERE "latitude" IS NOT NULL AND "longitude" IS NOT NULL;

-- CreateTable
CREATE TABLE "grid_cells" (
    "cell_key" VARCHAR(48) NOT NULL,
    "grid_size_m" INTEGER NOT NULL,
    "cell_x" BIGINT NOT NULL,
    "cell_y" BIGINT NOT NULL,
    "center_lat" DOUBLE PRECISION NOT NULL,
    "center_lng" DOUBLE PRECISION NOT NULL,
    "submitted_count" INTEGER NOT NULL DEFAULT 0,
    "verified_count" INTEGER NOT NULL DEFAULT 0,
    "last_report_at" TIMESTAMP(3),
    "cleanup_count" INTEGER NOT NULL DEFAULT 0,
    "last_cleaned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grid_cells_pkey" PRIMARY KEY ("cell_key")
);

-- CreateTable
CREATE TABLE "grid_cell_cleanups" (
    "id" UUID NOT NULL,
    "cell_key" VARCHAR(48) NOT NULL,
    "campaign_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "cleaned_at" TIMESTAMP(3) NOT NULL,
    "outcome" VARCHAR(10) NOT NULL,
    "report_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grid_cell_cleanups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reports_grid_key_created_at_idx" ON "reports"("grid_key", "created_at");
CREATE INDEX "grid_cells_cell_x_cell_y_idx" ON "grid_cells"("cell_x", "cell_y");
CREATE INDEX "grid_cells_submitted_count_idx" ON "grid_cells"("submitted_count" DESC);
CREATE UNIQUE INDEX "grid_cell_cleanups_cell_key_shift_id_key" ON "grid_cell_cleanups"("cell_key", "shift_id");
CREATE INDEX "grid_cell_cleanups_cell_key_cleaned_at_idx" ON "grid_cell_cleanups"("cell_key", "cleaned_at");
CREATE INDEX "grid_cell_cleanups_campaign_id_idx" ON "grid_cell_cleanups"("campaign_id");

-- AddForeignKey
ALTER TABLE "grid_cell_cleanups" ADD CONSTRAINT "grid_cell_cleanups_cell_key_fkey"
  FOREIGN KEY ("cell_key") REFERENCES "grid_cells"("cell_key") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill the cells from the existing reports (cleanup history starts empty).
INSERT INTO "grid_cells" ("cell_key", "grid_size_m", "cell_x", "cell_y", "center_lat", "center_lng",
                          "submitted_count", "verified_count", "last_report_at")
SELECT g."grid_key",
       split_part(g."grid_key", ':', 1)::int,
       split_part(g."grid_key", ':', 2)::bigint,
       split_part(g."grid_key", ':', 3)::bigint,
       ST_Y(c.pt), ST_X(c.pt),
       g.submitted, g.verified, g.last_at
FROM (
  SELECT "grid_key",
         count(*)::int AS submitted,
         (count(*) FILTER (WHERE "is_verify"))::int AS verified,
         max("created_at") AS last_at
  FROM "reports"
  WHERE "grid_key" IS NOT NULL AND "deleted_at" IS NULL
  GROUP BY "grid_key"
) g
CROSS JOIN LATERAL (
  SELECT ST_Transform(ST_SetSRID(ST_MakePoint(
    (split_part(g."grid_key", ':', 2)::bigint + 0.5) * split_part(g."grid_key", ':', 1)::int,
    (split_part(g."grid_key", ':', 3)::bigint + 0.5) * split_part(g."grid_key", ':', 1)::int), 32648), 4326) AS pt
) c;
