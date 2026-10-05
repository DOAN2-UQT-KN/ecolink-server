-- Result verification (3 layers) replaces the admin's manual completion review: Layer 1 photo
-- checks, one verification round per trash point declared cleaned, weighted resident votes.
-- The campaign-level "clean / not clean" answers are dropped (replaced by per-point votes).

ALTER TABLE "campaigns" ADD COLUMN "completion_awaiting_admin" BOOLEAN NOT NULL DEFAULT false;

DROP TABLE IF EXISTS "campaign_completion_verifications";

CREATE TABLE "result_photo_checks" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "side" VARCHAR(10) NOT NULL,
    "url" TEXT NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sha256" VARCHAR(64) NOT NULL,
    "exif_taken_at" TIMESTAMP(3),
    "exif_lat" DOUBLE PRECISION,
    "exif_lng" DOUBLE PRECISION,
    "camera_model" VARCHAR(120),
    "pin_lat" DOUBLE PRECISION NOT NULL,
    "pin_lng" DOUBLE PRECISION NOT NULL,
    "time_check" VARCHAR(10) NOT NULL,
    "exif_location_check" VARCHAR(10) NOT NULL,
    "pin_check" VARCHAR(10) NOT NULL,
    "level" VARCHAR(10) NOT NULL,
    "pin_distance_m" DOUBLE PRECISION,
    "exif_distance_m" DOUBLE PRECISION,

    CONSTRAINT "result_photo_checks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "result_photo_checks_sha256_idx" ON "result_photo_checks"("sha256");
CREATE INDEX "result_photo_checks_url_idx" ON "result_photo_checks"("url");
CREATE INDEX "result_photo_checks_campaign_id_report_id_idx" ON "result_photo_checks"("campaign_id", "report_id");

ALTER TABLE "result_photo_checks"
  ADD CONSTRAINT "result_photo_checks_campaign_id_fkey"
  FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "trash_point_verifications" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "reporter_id" UUID,
    "before_urls" TEXT[],
    "after_urls" TEXT[],
    "layer1_level" VARCHAR(10) NOT NULL,
    "layer1_issues" JSONB NOT NULL DEFAULT '[]',
    "score" INTEGER NOT NULL DEFAULT 0,
    "window_ends_at" TIMESTAMP(3) NOT NULL,
    "flagged_at" TIMESTAMP(3),
    "flag_deadline" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),
    "decided_by" UUID,
    "decision_code" VARCHAR(20),
    "decision_reason" TEXT,
    "reporter_reminded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trash_point_verifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "trash_point_verifications_campaign_id_report_id_round_key" ON "trash_point_verifications"("campaign_id", "report_id", "round");
CREATE INDEX "trash_point_verifications_status_window_ends_at_idx" ON "trash_point_verifications"("status", "window_ends_at");
CREATE INDEX "trash_point_verifications_report_id_idx" ON "trash_point_verifications"("report_id");

ALTER TABLE "trash_point_verifications"
  ADD CONSTRAINT "trash_point_verifications_campaign_id_fkey"
  FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "trash_point_votes" (
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
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trash_point_votes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "trash_point_votes_verification_id_user_id_key" ON "trash_point_votes"("verification_id", "user_id");
CREATE INDEX "trash_point_votes_user_id_created_at_idx" ON "trash_point_votes"("user_id", "created_at");

ALTER TABLE "trash_point_votes"
  ADD CONSTRAINT "trash_point_votes_verification_id_fkey"
  FOREIGN KEY ("verification_id") REFERENCES "trash_point_verifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
