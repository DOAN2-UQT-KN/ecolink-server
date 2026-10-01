-- Shift working window (spec 1.4 rev 5): defaults to its day's hours.
ALTER TABLE "campaign_shifts" ADD COLUMN "start_at" TIMESTAMP(3);
ALTER TABLE "campaign_shifts" ADD COLUMN "end_at" TIMESTAMP(3);

UPDATE "campaign_shifts" s
SET "start_at" = d."start_at", "end_at" = d."end_at"
FROM "campaign_days" d
WHERE d."id" = s."day_id";

ALTER TABLE "campaign_shifts" ALTER COLUMN "start_at" SET NOT NULL;
ALTER TABLE "campaign_shifts" ALTER COLUMN "end_at" SET NOT NULL;

CREATE INDEX "campaign_shifts_start_at_idx" ON "campaign_shifts"("start_at");

-- Per-shift registrations (spec 3.1).
CREATE TABLE "campaign_shift_registrations" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),
    "late_leave" BOOLEAN NOT NULL DEFAULT false,
    "manager_notified_at" TIMESTAMP(3),

    CONSTRAINT "campaign_shift_registrations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "campaign_shift_registrations_campaign_id_left_at_idx" ON "campaign_shift_registrations"("campaign_id", "left_at");
CREATE INDEX "campaign_shift_registrations_user_id_left_at_idx" ON "campaign_shift_registrations"("user_id", "left_at");
CREATE INDEX "campaign_shift_registrations_shift_id_idx" ON "campaign_shift_registrations"("shift_id");

-- One live registration per shift and user; left rows are kept for history.
CREATE UNIQUE INDEX "campaign_shift_registrations_live_key"
    ON "campaign_shift_registrations"("shift_id", "user_id")
    WHERE "left_at" IS NULL;

ALTER TABLE "campaign_shift_registrations" ADD CONSTRAINT "campaign_shift_registrations_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_shift_registrations" ADD CONSTRAINT "campaign_shift_registrations_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "campaign_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
