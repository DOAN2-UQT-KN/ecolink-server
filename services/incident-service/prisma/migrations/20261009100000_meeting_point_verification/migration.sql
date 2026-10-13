-- Result verification, spec version 2: the vote and the decision move from the trash point to the
-- meeting point (Layer 1 still grades each photo and trash point). The per-trash-point rounds and
-- votes are dropped (dev data only; rounds open again when a campaign is marked done).

DROP TABLE IF EXISTS "trash_point_votes";
DROP TABLE IF EXISTS "trash_point_verifications";

-- CreateTable
CREATE TABLE "meeting_point_verifications" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "meeting_point_id" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "report_ids" UUID[],
    "reporter_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "layer1_level" VARCHAR(10) NOT NULL,
    "layer1" JSONB NOT NULL DEFAULT '[]',
    "score" INTEGER NOT NULL DEFAULT 0,
    "window_ends_at" TIMESTAMP(3) NOT NULL,
    "flagged_at" TIMESTAMP(3),
    "flag_deadline" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),
    "decided_by" UUID,
    "decision_code" VARCHAR(20),
    "decision_reason" TEXT,
    "failed_report_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "reporter_reminded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_point_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_point_votes" (
    "id" UUID NOT NULL,
    "verification_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "value" INTEGER NOT NULL,
    "weight" INTEGER NOT NULL,
    "weight_reason" VARCHAR(30) NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracy" DOUBLE PRECISION,
    "distance_m" DOUBLE PRECISION,
    "note" TEXT,
    "photo_url" TEXT,
    "flagged_report_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_point_votes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meeting_point_verifications_status_window_ends_at_idx" ON "meeting_point_verifications"("status", "window_ends_at");

-- CreateIndex
CREATE INDEX "meeting_point_verifications_meeting_point_id_idx" ON "meeting_point_verifications"("meeting_point_id");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_point_verifications_campaign_id_meeting_point_id_ro_key" ON "meeting_point_verifications"("campaign_id", "meeting_point_id", "round");

-- CreateIndex
CREATE INDEX "meeting_point_votes_user_id_created_at_idx" ON "meeting_point_votes"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_point_votes_verification_id_user_id_key" ON "meeting_point_votes"("verification_id", "user_id");

-- AddForeignKey
ALTER TABLE "meeting_point_verifications" ADD CONSTRAINT "meeting_point_verifications_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_point_verifications" ADD CONSTRAINT "meeting_point_verifications_meeting_point_id_fkey" FOREIGN KEY ("meeting_point_id") REFERENCES "campaign_meeting_points"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_point_votes" ADD CONSTRAINT "meeting_point_votes_verification_id_fkey" FOREIGN KEY ("verification_id") REFERENCES "meeting_point_verifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "organization_owner_change_approvals_application_id_approver_use" RENAME TO "organization_owner_change_approvals_application_id_approver_key";


-- Campaigns waiting for completion lost their voting rounds: the admin decides them (as for the
-- campaigns that were waiting when result verification shipped). 7 = PENDING_COMPLETION.
UPDATE "campaigns" SET "completion_awaiting_admin" = true
WHERE "status" = 7
  AND "deleted_at" IS NULL
  AND "completion_awaiting_admin" = false;
