CREATE TABLE "report_vote_green_point_rules" (
    "id" UUID NOT NULL,
    "threshold" INTEGER NOT NULL,
    "points" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_vote_green_point_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "report_vote_green_point_rules_threshold_key"
ON "report_vote_green_point_rules" ("threshold");

CREATE INDEX "report_vote_green_point_rules_active_threshold_idx"
ON "report_vote_green_point_rules" ("is_active", "threshold");
