-- Convert seasons.status from enum SeasonStatus to integer status codes
-- ACTIVE => 1, all other historical values => 2
ALTER TABLE "seasons"
  ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "seasons"
  ALTER COLUMN "status" TYPE INTEGER
  USING (
    CASE
      WHEN "status"::TEXT = 'ACTIVE' THEN 1
      ELSE 2
    END
  );

ALTER TABLE "seasons"
  ALTER COLUMN "status" SET DEFAULT 1;

DROP TYPE IF EXISTS "SeasonStatus";
