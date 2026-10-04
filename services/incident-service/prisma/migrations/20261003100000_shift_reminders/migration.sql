-- Reminders 24 h and 1 h before each day's gathering time (spec 3.7).
ALTER TABLE "campaign_shift_registrations" ADD COLUMN "reminded_24h_at" TIMESTAMP(3);
ALTER TABLE "campaign_shift_registrations" ADD COLUMN "reminded_1h_at" TIMESTAMP(3);
