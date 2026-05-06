-- Badge rules engine refactor: scope, repeatability, JSON rules AST.

-- 1) New enum type for badge scope.
CREATE TYPE "BadgeScope" AS ENUM ('LIFETIME', 'SEASON');

-- 2) BadgeDefinition schema changes.
ALTER TABLE "badge_definitions"
  ADD COLUMN "scope" "BadgeScope" NOT NULL DEFAULT 'SEASON',
  ADD COLUMN "is_repeatable" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "max_grants_per_user" INTEGER NULL,
  ADD COLUMN "cooldown_seconds" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "rules_config" JSONB NULL;

-- Drop legacy rule fields.
ALTER TABLE "badge_definitions"
  DROP COLUMN IF EXISTS "rule_type",
  DROP COLUMN IF EXISTS "metric",
  DROP COLUMN IF EXISTS "threshold",
  DROP COLUMN IF EXISTS "rank_top_n";

-- Drop legacy indexes if they exist (defensive).
DO $$
BEGIN
  IF to_regclass('public."badge_definitions_rule_type_is_active_idx"') IS NOT NULL THEN
    DROP INDEX "badge_definitions_rule_type_is_active_idx";
  END IF;
  IF to_regclass('public."badge_definitions_metric_is_active_idx"') IS NOT NULL THEN
    DROP INDEX "badge_definitions_metric_is_active_idx";
  END IF;
END $$;

-- 3) UserBadgeGrant: make season nullable and allow multiple grants.
ALTER TABLE "user_badge_grants"
  ALTER COLUMN "season_id" DROP NOT NULL;

-- Drop old uniqueness constraint if present.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_badge_grants_user_id_badge_id_season_id_key'
  ) THEN
    ALTER TABLE "user_badge_grants"
      DROP CONSTRAINT "user_badge_grants_user_id_badge_id_season_id_key";
  END IF;
END $$;

-- Add supporting indexes for common access patterns.
CREATE INDEX IF NOT EXISTS "user_badge_grants_user_id_idx" ON "user_badge_grants" ("user_id");
CREATE INDEX IF NOT EXISTS "user_badge_grants_badge_id_idx" ON "user_badge_grants" ("badge_id");
CREATE INDEX IF NOT EXISTS "user_badge_grants_season_id_idx" ON "user_badge_grants" ("season_id");

