-- Gamification core: seasonal RP (CRP/VRP), unified ledger, SP wallet batches, badges, snapshots.
-- Coexists with legacy green_point_* tables; migrate spend semantics to SP over time.

CREATE TYPE "SeasonStatus" AS ENUM ('ACTIVE', 'FROZEN', 'CLOSED');
CREATE TYPE "SeasonKind" AS ENUM ('MONTHLY', 'QUARTERLY');
CREATE TYPE "PointKind" AS ENUM ('CRP', 'VRP', 'SP');
CREATE TYPE "PointSourceType" AS ENUM ('REPORT', 'CAMPAIGN', 'SYSTEM', 'STORE', 'SEASON_END');
CREATE TYPE "LeaderboardSubjectKind" AS ENUM ('USER', 'ORGANIZATION');
CREATE TYPE "LeaderboardMetric" AS ENUM ('CRP', 'VRP', 'ORG_AGGREGATE');
CREATE TYPE "BadgeRuleType" AS ENUM ('CRP', 'VRP', 'RANK');

CREATE TABLE "seasons" (
    "id" UUID NOT NULL,
    "label" VARCHAR(128),
    "season_kind" "SeasonKind" NOT NULL,
    "status" "SeasonStatus" NOT NULL DEFAULT 'ACTIVE',
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seasons_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "seasons_status_idx" ON "seasons"("status");
CREATE INDEX "seasons_starts_at_ends_at_idx" ON "seasons"("starts_at", "ends_at");

CREATE TABLE "user_sp_wallet" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "source_type" "PointSourceType" NOT NULL,
    "source_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_sp_wallet_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_sp_wallet_user_id_expires_at_idx" ON "user_sp_wallet"("user_id", "expires_at");
CREATE INDEX "user_sp_wallet_expires_at_idx" ON "user_sp_wallet"("expires_at");

CREATE TABLE "user_point_transactions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "PointKind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "source_type" "PointSourceType" NOT NULL,
    "source_id" UUID,
    "season_id" UUID,
    "metadata" JSONB,
    "idempotency_key" VARCHAR(256),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_point_transactions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_point_transactions_user_id_created_at_idx" ON "user_point_transactions"("user_id", "created_at");
CREATE INDEX "user_point_transactions_user_id_kind_idx" ON "user_point_transactions"("user_id", "kind");
CREATE INDEX "user_point_transactions_season_id_idx" ON "user_point_transactions"("season_id");
CREATE INDEX "user_point_transactions_source_type_source_id_idx" ON "user_point_transactions"("source_type", "source_id");

ALTER TABLE "user_point_transactions" ADD CONSTRAINT "user_point_transactions_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "user_point_transactions_idempotency_partial" ON "user_point_transactions"("user_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;

CREATE TABLE "user_season_rp_totals" (
    "user_id" UUID NOT NULL,
    "season_id" UUID NOT NULL,
    "citizen_rp" INTEGER NOT NULL DEFAULT 0,
    "volunteer_rp" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_season_rp_totals_pkey" PRIMARY KEY ("user_id","season_id")
);

CREATE INDEX "user_season_rp_totals_season_id_citizen_rp_idx" ON "user_season_rp_totals"("season_id", "citizen_rp" DESC);
CREATE INDEX "user_season_rp_totals_season_id_volunteer_rp_idx" ON "user_season_rp_totals"("season_id", "volunteer_rp" DESC);

ALTER TABLE "user_season_rp_totals" ADD CONSTRAINT "user_season_rp_totals_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "organization_season_scores" (
    "organization_id" UUID NOT NULL,
    "season_id" UUID NOT NULL,
    "aggregate_score" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_season_scores_pkey" PRIMARY KEY ("organization_id","season_id")
);

CREATE INDEX "organization_season_scores_season_id_aggregate_score_idx" ON "organization_season_scores"("season_id", "aggregate_score" DESC);

ALTER TABLE "organization_season_scores" ADD CONSTRAINT "organization_season_scores_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "report_milestone_awards" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "season_id" UUID NOT NULL,
    "milestone_threshold" INTEGER NOT NULL,
    "ledger_tx_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_milestone_awards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "report_milestone_awards_report_id_user_id_season_id_milestone_threshold_key" ON "report_milestone_awards"("report_id", "user_id", "season_id", "milestone_threshold");

CREATE INDEX "report_milestone_awards_user_id_idx" ON "report_milestone_awards"("user_id");

ALTER TABLE "report_milestone_awards" ADD CONSTRAINT "report_milestone_awards_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "campaign_reward_awards" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "season_id" UUID NOT NULL,
    "award_key" VARCHAR(128) NOT NULL,
    "ledger_tx_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_reward_awards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "campaign_reward_awards_campaign_id_user_id_season_id_award_key_key" ON "campaign_reward_awards"("campaign_id", "user_id", "season_id", "award_key");

CREATE INDEX "campaign_reward_awards_user_id_idx" ON "campaign_reward_awards"("user_id");

ALTER TABLE "campaign_reward_awards" ADD CONSTRAINT "campaign_reward_awards_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "gamification_point_rules" (
    "id" UUID NOT NULL,
    "base_report_point" INTEGER NOT NULL,
    "report_milestone_thresholds" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "volunteer_bonus_cap_by_difficulty" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gamification_point_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "gamification_point_rules_is_active_effective_from_idx" ON "gamification_point_rules"("is_active", "effective_from" DESC);

CREATE TABLE "volunteer_org_multiplier_rules" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "multiplier" DECIMAL(4,2) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "volunteer_org_multiplier_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "volunteer_org_multiplier_rules_code_key" ON "volunteer_org_multiplier_rules"("code");

CREATE INDEX "volunteer_org_multiplier_rules_is_active_priority_idx" ON "volunteer_org_multiplier_rules"("is_active", "priority" DESC);

CREATE TABLE "spendable_point_rules" (
    "id" UUID NOT NULL,
    "expiration_days" INTEGER NOT NULL DEFAULT 90,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spendable_point_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "spendable_point_rules_is_active_effective_from_idx" ON "spendable_point_rules"("is_active", "effective_from" DESC);

CREATE TABLE "season_schedule_rules" (
    "id" UUID NOT NULL,
    "season_kind" "SeasonKind" NOT NULL,
    "auto_rotate" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "season_schedule_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "season_schedule_rules_season_kind_key" ON "season_schedule_rules"("season_kind");

CREATE TABLE "season_leaderboard_payout_tiers" (
    "id" UUID NOT NULL,
    "season_id" UUID,
    "metric" "LeaderboardMetric" NOT NULL,
    "rank_min" INTEGER NOT NULL,
    "rank_max" INTEGER NOT NULL,
    "sp_amount" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "season_leaderboard_payout_tiers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "season_leaderboard_payout_tiers_season_id_metric_idx" ON "season_leaderboard_payout_tiers"("season_id", "metric");

ALTER TABLE "season_leaderboard_payout_tiers" ADD CONSTRAINT "season_leaderboard_payout_tiers_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "badge_definitions" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(128) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "rule_type" "BadgeRuleType" NOT NULL,
    "threshold" INTEGER,
    "rank_top_n" INTEGER,
    "rank_metric" "LeaderboardMetric",
    "reward" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "badge_definitions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "badge_definitions_slug_key" ON "badge_definitions"("slug");

CREATE INDEX "badge_definitions_rule_type_is_active_idx" ON "badge_definitions"("rule_type", "is_active");

CREATE TABLE "user_badge_grants" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "badge_id" UUID NOT NULL,
    "season_id" UUID NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "user_badge_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_badge_grants_user_id_badge_id_season_id_key" ON "user_badge_grants"("user_id", "badge_id", "season_id");

CREATE INDEX "user_badge_grants_user_id_idx" ON "user_badge_grants"("user_id");

ALTER TABLE "user_badge_grants" ADD CONSTRAINT "user_badge_grants_badge_id_fkey" FOREIGN KEY ("badge_id") REFERENCES "badge_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_badge_grants" ADD CONSTRAINT "user_badge_grants_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "leaderboard_snapshots" (
    "id" UUID NOT NULL,
    "season_id" UUID NOT NULL,
    "subject_kind" "LeaderboardSubjectKind" NOT NULL,
    "subject_id" UUID NOT NULL,
    "metric" "LeaderboardMetric" NOT NULL,
    "score" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leaderboard_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "leaderboard_snapshots_season_id_subject_kind_subject_id_metric_key" ON "leaderboard_snapshots"("season_id", "subject_kind", "subject_id", "metric");

CREATE INDEX "leaderboard_snapshots_season_id_metric_rank_idx" ON "leaderboard_snapshots"("season_id", "metric", "rank");

ALTER TABLE "leaderboard_snapshots" ADD CONSTRAINT "leaderboard_snapshots_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
