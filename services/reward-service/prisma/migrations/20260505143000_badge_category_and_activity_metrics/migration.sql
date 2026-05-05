-- Extend badge model with category and activity-driven metrics.
-- Adds:
-- - LeaderboardMetric: REPORT_UPVOTES, REPORT_COUNT, CAMPAIGN_COMPLETED
-- - BadgeCategory enum
-- - badge_definitions.category + supporting index

ALTER TYPE "LeaderboardMetric" ADD VALUE 'REPORT_UPVOTES';
ALTER TYPE "LeaderboardMetric" ADD VALUE 'REPORT_COUNT';
ALTER TYPE "LeaderboardMetric" ADD VALUE 'CAMPAIGN_COMPLETED';

CREATE TYPE "BadgeCategory" AS ENUM ('REPORT', 'CAMPAIGN', 'CONTRIBUTION', 'RANK');

ALTER TABLE "badge_definitions"
ADD COLUMN "category" "BadgeCategory";

UPDATE "badge_definitions"
SET "category" = CASE
  WHEN "metric"::text LIKE 'REPORT\_%' THEN 'REPORT'::"BadgeCategory"
  WHEN "metric"::text LIKE 'CAMPAIGN\_%' THEN 'CAMPAIGN'::"BadgeCategory"
  WHEN "rule_type"::text = 'RANK' THEN 'RANK'::"BadgeCategory"
  ELSE 'CONTRIBUTION'::"BadgeCategory"
END;

ALTER TABLE "badge_definitions"
ALTER COLUMN "category" SET NOT NULL;

CREATE INDEX "badge_definitions_category_is_active_idx"
ON "badge_definitions"("category", "is_active");
