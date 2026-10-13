-- Spec 3.7 (website): CAMPAIGN_SHIFT_REMINDER, a volunteer's reminder 24 h (`hours` = 24) and 1 h
-- before the gathering time of a day they registered for. Follows the volunteerRequest preference.
-- Rollback: enum values cannot be dropped in Postgres without recreating the type.

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'CAMPAIGN_SHIFT_REMINDER';
