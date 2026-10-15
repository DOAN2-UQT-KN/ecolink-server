-- Report verification (specs/006, plan P01): category + wasteTypes, geography location,
-- idempotency key, moderation columns, capture source on report images.

-- CreateEnum
CREATE TYPE "ReportCategory" AS ENUM ('WATERWAY', 'BEACH', 'MARKET', 'SCHOOL', 'PARK', 'INDUSTRIAL_ZONE', 'ALLEY', 'STREET', 'ILLEGAL_DUMP', 'DRAIN', 'OPEN_BURNING', 'OTHER');
CREATE TYPE "WasteType" AS ENUM ('HOUSEHOLD', 'CONSTRUCTION', 'INDUSTRIAL', 'HAZARDOUS');
CREATE TYPE "CaptureSource" AS ENUM ('LIVE', 'GALLERY');
CREATE TYPE "ModerationReasonCode" AS ENUM ('DUPLICATE_OF_OTHER', 'NOT_ON_SITE', 'INAPPROPRIATE_CONTENT');

-- AlterTable: existing reports get category OTHER (ContextCheck skips them).
ALTER TABLE "reports" ADD COLUMN     "category" "ReportCategory" NOT NULL DEFAULT 'OTHER',
ADD COLUMN     "idempotency_key" VARCHAR(64),
ADD COLUMN     "latest_verification_id" UUID,
ADD COLUMN     "location" geography(Point, 4326),
ADD COLUMN     "moderated_at" TIMESTAMP(3),
ADD COLUMN     "moderated_by" UUID,
ADD COLUMN     "moderation_reason_code" "ModerationReasonCode",
ADD COLUMN     "waste_types" "WasteType"[] DEFAULT ARRAY[]::"WasteType"[];

-- Backfill waste_types from the free-text CSV column; unknown values are dropped.
UPDATE "reports" SET "waste_types" = ARRAY(
  SELECT DISTINCT upper(trim(x))::"WasteType"
  FROM unnest(string_to_array("waste_type", ',')) AS x
  WHERE upper(trim(x)) IN ('HOUSEHOLD', 'CONSTRUCTION', 'INDUSTRIAL', 'HAZARDOUS')
) WHERE "waste_type" IS NOT NULL;

-- location follows latitude/longitude so spatial queries can use a GiST index.
CREATE OR REPLACE FUNCTION reports_sync_location() RETURNS trigger AS $$
BEGIN
  IF NEW."latitude" IS NOT NULL AND NEW."longitude" IS NOT NULL THEN
    NEW."location" := ST_SetSRID(ST_MakePoint(NEW."longitude", NEW."latitude"), 4326)::geography;
  ELSE
    NEW."location" := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "reports_sync_location"
BEFORE INSERT OR UPDATE OF "latitude", "longitude" ON "reports"
FOR EACH ROW EXECUTE FUNCTION reports_sync_location();

UPDATE "reports"
SET "location" = ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography
WHERE "latitude" IS NOT NULL AND "longitude" IS NOT NULL;

-- AlterTable
ALTER TABLE "report_media_files" ADD COLUMN     "capture_id" UUID,
ADD COLUMN     "capture_source" "CaptureSource" NOT NULL DEFAULT 'GALLERY';

-- CreateIndex
CREATE INDEX "reports_location_gist" ON "reports" USING GIST ("location");
CREATE INDEX "reports_user_id_created_at_idx" ON "reports"("user_id", "created_at");
CREATE UNIQUE INDEX "reports_user_id_idempotency_key_key" ON "reports"("user_id", "idempotency_key");
CREATE UNIQUE INDEX "report_media_files_capture_id_key" ON "report_media_files"("capture_id");
