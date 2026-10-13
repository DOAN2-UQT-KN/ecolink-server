-- Spec rev 6: registering never records a violation, so late leaves go away.
ALTER TABLE "campaign_shift_registrations" DROP COLUMN "late_leave";
-- Left because a manager turned the shift off.
ALTER TABLE "campaign_shift_registrations" ADD COLUMN "closed_by_shift" BOOLEAN NOT NULL DEFAULT false;

-- Staffing alerts (spec 3.2): sent once per day / per over-max episode.
ALTER TABLE "campaign_days" ADD COLUMN "understaffed_notified_at" TIMESTAMP(3);
ALTER TABLE "campaign_shifts" ADD COLUMN "over_max_notified_at" TIMESTAMP(3);

-- Re-inviting nearby residents is limited to once a day.
ALTER TABLE "campaigns" ADD COLUMN "last_nearby_invite_at" TIMESTAMP(3);
