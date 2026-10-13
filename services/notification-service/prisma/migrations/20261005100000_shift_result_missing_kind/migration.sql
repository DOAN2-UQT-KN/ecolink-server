-- Spec 4.2 (website): CAMPAIGN_SHIFT_RESULT_MISSING, sent daily to a shift's leader and the
-- campaign's managers while a shift is still waiting for its result 24 h after its end.
-- Bypasses notification preferences. Rollback: enum values cannot be dropped in Postgres without
-- recreating the type.

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'CAMPAIGN_SHIFT_RESULT_MISSING';
