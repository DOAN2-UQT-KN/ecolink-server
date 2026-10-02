-- Campaign schedule becomes a grid of days x meeting points (spec 1.4).
-- A day has its own start and end; a shift (day x meeting point) holds the gathering time,
-- the volunteer slots (0 = off) and the person in charge.

CREATE TABLE "campaign_days" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "campaign_days_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "campaign_days_campaign_id_idx" ON "campaign_days"("campaign_id");
CREATE INDEX "campaign_days_start_at_idx" ON "campaign_days"("start_at");
ALTER TABLE "campaign_days" ADD CONSTRAINT "campaign_days_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "campaign_shifts" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "day_id" UUID NOT NULL,
    "meeting_point_id" UUID NOT NULL,
    "gather_at" TIMESTAMP(3),
    "slots" INTEGER NOT NULL DEFAULT 0,
    "leader_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "campaign_shifts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "campaign_shifts_day_id_meeting_point_id_key" ON "campaign_shifts"("day_id", "meeting_point_id");
CREATE INDEX "campaign_shifts_campaign_id_idx" ON "campaign_shifts"("campaign_id");
ALTER TABLE "campaign_shifts" ADD CONSTRAINT "campaign_shifts_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_shifts" ADD CONSTRAINT "campaign_shifts_day_id_fkey"
    FOREIGN KEY ("day_id") REFERENCES "campaign_days"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_shifts" ADD CONSTRAINT "campaign_shifts_meeting_point_id_fkey"
    FOREIGN KEY ("meeting_point_id") REFERENCES "campaign_meeting_points"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-point scheduling moves to shifts; the campaign-wide dates come from its days.
ALTER TABLE "campaign_meeting_points" DROP COLUMN "gather_at",
    DROP COLUMN "slots",
    DROP COLUMN "leader_user_id";
ALTER TABLE "campaigns" DROP COLUMN "start_date",
    DROP COLUMN "end_date";
