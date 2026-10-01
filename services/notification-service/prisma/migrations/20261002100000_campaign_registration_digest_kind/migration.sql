-- CAMPAIGN_REGISTRATION_DIGEST  website, once a day to each manager of a campaign that got new
--                               shift registrations, with the count per campaign day.
-- Rollback: enum values cannot be dropped in Postgres without recreating the type.

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'CAMPAIGN_REGISTRATION_DIGEST';
