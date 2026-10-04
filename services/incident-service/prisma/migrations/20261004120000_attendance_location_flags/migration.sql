-- Scans outside 50 m or with a poor GPS are recorded and flagged instead of refused; a leader or
-- manager may exclude an attendance from the points (and restore it).
ALTER TABLE "campaign_shift_attendances" ADD COLUMN "check_in_distance_m" DOUBLE PRECISION;
ALTER TABLE "campaign_shift_attendances" ADD COLUMN "check_out_distance_m" DOUBLE PRECISION;
ALTER TABLE "campaign_shift_attendances" ADD COLUMN "out_of_area" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "campaign_shift_attendances" ADD COLUMN "low_accuracy" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "campaign_shift_attendances" ADD COLUMN "excluded_at" TIMESTAMP(3);
ALTER TABLE "campaign_shift_attendances" ADD COLUMN "excluded_by" UUID;
ALTER TABLE "campaign_shift_attendances" ADD COLUMN "exclude_reason" TEXT;
