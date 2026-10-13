-- Coordinates picked on the map when the organization applied, so the organization can be
-- placed on a map later. Nullable: the map step is optional.
-- Rollback: ALTER TABLE "organizations" DROP COLUMN "latitude", DROP COLUMN "longitude";

-- AlterTable
ALTER TABLE "organizations"
    ADD COLUMN "latitude" DOUBLE PRECISION,
    ADD COLUMN "longitude" DOUBLE PRECISION;
