-- Add bilingual columns while keeping legacy columns for backward compatibility.
ALTER TABLE "difficulties"
  ADD COLUMN "name_vi" VARCHAR(64),
  ADD COLUMN "name_en" VARCHAR(64);

ALTER TABLE "gifts"
  ADD COLUMN "name_vi" VARCHAR(255),
  ADD COLUMN "name_en" VARCHAR(255),
  ADD COLUMN "description_vi" TEXT,
  ADD COLUMN "description_en" TEXT;

-- Data backfill: existing text is treated as Vietnamese.
UPDATE "difficulties"
SET "name_vi" = COALESCE("name_vi", "name");

UPDATE "gifts"
SET
  "name_vi" = COALESCE("name_vi", "name"),
  "description_vi" = COALESCE("description_vi", "description");
