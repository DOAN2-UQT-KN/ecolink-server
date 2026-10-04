-- Suggested minimum volunteers per campaign day, by difficulty (campaign spec 1.3 / 1.4).
ALTER TABLE "difficulties" ADD COLUMN "suggested_min_volunteers" INTEGER;

UPDATE "difficulties" SET "suggested_min_volunteers" = CASE "level"
  WHEN 1 THEN 5
  WHEN 2 THEN 10
  WHEN 3 THEN 20
  WHEN 4 THEN 30
END
WHERE "suggested_min_volunteers" IS NULL;
