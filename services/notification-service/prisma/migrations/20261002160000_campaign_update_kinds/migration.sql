-- Spec 3.5 edits of an approved campaign (website):
--   CAMPAIGN_UPDATED_NEEDS_REVIEW  volunteers who keep their place, when an important field
--                                  changed (`underReview` = back under review meanwhile)
--   CAMPAIGN_REREVIEW_EXPIRED      those volunteers, when the review did not finish before the start
-- Rollback: enum values cannot be dropped in Postgres without recreating the type.

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'CAMPAIGN_UPDATED_NEEDS_REVIEW';
ALTER TYPE "NotificationKind" ADD VALUE 'CAMPAIGN_REREVIEW_EXPIRED';
