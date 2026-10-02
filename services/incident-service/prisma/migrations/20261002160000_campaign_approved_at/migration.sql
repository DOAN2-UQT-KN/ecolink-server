-- Spec 3.5: an approved campaign whose important fields are edited goes back to review while its
-- volunteers keep their place. `approved_at` tells a re-review from a first review.
-- Backfill: the last `approve` in the status log, else `updated_at` for campaigns past approval
-- (27 UPCOMING, 1 ACTIVE, 7 PENDING_COMPLETION, 9 LEGACY_IN_REVIEW, 17 COMPLETED).
-- Rollback: ALTER TABLE "campaigns" DROP COLUMN "approved_at";

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN "approved_at" TIMESTAMP(3);

UPDATE "campaigns" c
SET "approved_at" = COALESCE(
  (SELECT MIN(l."created_at") FROM "campaign_status_logs" l
   WHERE l."campaign_id" = c."id" AND l."event" = 'approve'),
  CASE WHEN c."status" IN (27, 1, 7, 9, 17) THEN c."updated_at" END
);
