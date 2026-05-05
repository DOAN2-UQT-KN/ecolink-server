-- Refactor badges: rule_type = THRESHOLD | RANK; metric = CRP | VRP | ORG_AGGREGATE; slug lock columns.

ALTER TYPE "BadgeRuleType" RENAME TO "BadgeRuleType_legacy";

CREATE TYPE "BadgeRuleType" AS ENUM ('THRESHOLD', 'RANK');

ALTER TABLE "badge_definitions" ADD COLUMN "rule_type_new" "BadgeRuleType";

UPDATE "badge_definitions"
SET "rule_type_new" = CASE
  WHEN "rule_type"::text IN ('CRP', 'VRP') THEN 'THRESHOLD'::"BadgeRuleType"
  ELSE 'RANK'::"BadgeRuleType"
END;

ALTER TABLE "badge_definitions" ADD COLUMN "metric" "LeaderboardMetric";

UPDATE "badge_definitions"
SET "metric" = CASE
  WHEN "rule_type"::text = 'CRP' THEN 'CRP'::"LeaderboardMetric"
  WHEN "rule_type"::text = 'VRP' THEN 'VRP'::"LeaderboardMetric"
  WHEN "rule_type"::text = 'RANK' THEN COALESCE("rank_metric", 'CRP'::"LeaderboardMetric")
END;

ALTER TABLE "badge_definitions" ALTER COLUMN "metric" SET NOT NULL;

ALTER TABLE "badge_definitions" DROP COLUMN "rank_metric";

ALTER TABLE "badge_definitions" DROP COLUMN "rule_type";

ALTER TABLE "badge_definitions" RENAME COLUMN "rule_type_new" TO "rule_type";

ALTER TABLE "badge_definitions" ALTER COLUMN "rule_type" SET NOT NULL;

DROP TYPE "BadgeRuleType_legacy";

ALTER TABLE "badge_definitions" ADD COLUMN "published_at" TIMESTAMP(3),
ADD COLUMN "slug_locked_at" TIMESTAMP(3);

UPDATE "badge_definitions" bd
SET "slug_locked_at" = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1 FROM "user_badge_grants" g WHERE g."badge_id" = bd."id"
);

DROP INDEX IF EXISTS "badge_definitions_rule_type_is_active_idx";

CREATE INDEX "badge_definitions_rule_type_is_active_idx" ON "badge_definitions"("rule_type", "is_active");

CREATE INDEX "badge_definitions_metric_is_active_idx" ON "badge_definitions"("metric", "is_active");
