-- CAMPAIGN_CANCELLED  website, to the creator and owners when an admin locks the organization and
--                     its draft / under-review / waiting-for-changes campaigns are cancelled.
-- Rollback: enum values cannot be dropped in Postgres without recreating the type.

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'CAMPAIGN_CANCELLED';
