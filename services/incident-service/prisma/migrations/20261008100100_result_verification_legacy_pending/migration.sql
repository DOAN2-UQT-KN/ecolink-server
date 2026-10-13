-- Campaigns already waiting for completion when result verification shipped have no voting
-- rounds (they were marked done under the manual review): the admin decides them, as before.
-- 7 = PENDING_COMPLETION (GlobalStatus._STATUS_WAITING_CONFIRMED).
UPDATE "campaigns" SET "completion_awaiting_admin" = true
WHERE "status" = 7
  AND "deleted_at" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "trash_point_verifications" v WHERE v."campaign_id" = "campaigns"."id"
  );
