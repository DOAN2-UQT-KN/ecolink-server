-- Point rules own every earning rate (spec 013): campaign completion and report completion.
ALTER TABLE "gamification_point_rules"
  ADD COLUMN "campaign_completion_points" INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN "report_completion_points" INTEGER NOT NULL DEFAULT 0,
  DROP COLUMN "volunteer_bonus_cap_by_difficulty";

-- CreateTable
CREATE TABLE "gamification_point_rule_history" (
    "id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "changed_by" UUID NOT NULL,
    "before" JSONB,
    "after" JSONB NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gamification_point_rule_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gamification_point_rule_history_rule_id_changed_at_idx" ON "gamification_point_rule_history"("rule_id", "changed_at" DESC);

-- AddForeignKey
ALTER TABLE "gamification_point_rule_history" ADD CONSTRAINT "gamification_point_rule_history_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "gamification_point_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Legacy copy of the vote milestones; nothing reads it.
DROP TABLE IF EXISTS "report_vote_green_point_rules";
