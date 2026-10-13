-- Mail sent when the submitter presses "Save draft" (not on "Continue"), at most once an hour
-- per application. Addressed by email only (payload.toEmail).
-- Rollback: enum values cannot be dropped in Postgres without recreating the type.

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'ORG_APPLICATION_DRAFT_UPDATED';
