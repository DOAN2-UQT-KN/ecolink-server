-- Attendance per shift (spec 4.1): QR sessions and one row per volunteer per shift.
-- The per-campaign `campaign_attendance_check_ins` stays as history only.
CREATE TABLE "campaign_shift_attendance_sessions" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "opened_by" UUID NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),
    "closed_by" UUID,

    CONSTRAINT "campaign_shift_attendance_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "campaign_shift_attendance_sessions_shift_id_opened_at_idx"
  ON "campaign_shift_attendance_sessions"("shift_id", "opened_at");

ALTER TABLE "campaign_shift_attendance_sessions"
  ADD CONSTRAINT "campaign_shift_attendance_sessions_campaign_id_fkey"
  FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_shift_attendance_sessions"
  ADD CONSTRAINT "campaign_shift_attendance_sessions_shift_id_fkey"
  FOREIGN KEY ("shift_id") REFERENCES "campaign_shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "campaign_shift_attendances" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "check_in_at" TIMESTAMP(3) NOT NULL,
    "check_out_at" TIMESTAMP(3),
    "check_in_latitude" DOUBLE PRECISION,
    "check_in_longitude" DOUBLE PRECISION,
    "check_in_accuracy" DOUBLE PRECISION,
    "check_out_latitude" DOUBLE PRECISION,
    "check_out_longitude" DOUBLE PRECISION,
    "check_out_accuracy" DOUBLE PRECISION,
    "check_out_method" VARCHAR(20),
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "manual_reason" TEXT,
    "recorded_by" UUID,
    "pre_registered" BOOLEAN NOT NULL,
    "offline" BOOLEAN NOT NULL DEFAULT false,
    "session_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_shift_attendances_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "campaign_shift_attendances_shift_id_user_id_key"
  ON "campaign_shift_attendances"("shift_id", "user_id");
CREATE INDEX "campaign_shift_attendances_campaign_id_user_id_idx"
  ON "campaign_shift_attendances"("campaign_id", "user_id");

ALTER TABLE "campaign_shift_attendances"
  ADD CONSTRAINT "campaign_shift_attendances_campaign_id_fkey"
  FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_shift_attendances"
  ADD CONSTRAINT "campaign_shift_attendances_shift_id_fkey"
  FOREIGN KEY ("shift_id") REFERENCES "campaign_shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
