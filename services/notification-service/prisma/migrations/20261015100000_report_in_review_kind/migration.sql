-- Report verification (specs/006 P05): the owner is told when automatic verification sends the
-- report to moderator review. Rollback: enum values cannot be dropped in Postgres without
-- recreating the type.

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'REPORT_IN_REVIEW';
