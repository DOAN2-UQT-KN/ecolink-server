-- Result verification (3 layers): the original reporter is asked to confirm a cleaned trash point
-- (priority notice, reminded once after 24 h), admins hear of flagged points, owners and managers
-- hear of rejected points and of the campaign's verified / rejected result. Rollback: enum values
-- cannot be dropped in Postgres without recreating the type.

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'CAMPAIGN_TRASH_POINT_CONFIRM_REQUEST';
ALTER TYPE "NotificationKind" ADD VALUE 'CAMPAIGN_TRASH_POINT_CONFIRM_REMINDER';
ALTER TYPE "NotificationKind" ADD VALUE 'CAMPAIGN_TRASH_POINT_FLAGGED';
ALTER TYPE "NotificationKind" ADD VALUE 'CAMPAIGN_TRASH_POINT_REJECTED';
ALTER TYPE "NotificationKind" ADD VALUE 'CAMPAIGN_RESULT_VERIFIED';
ALTER TYPE "NotificationKind" ADD VALUE 'CAMPAIGN_RESULT_REJECTED';
