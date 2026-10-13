-- Spec 3.2 staffing notices (website):
--   CAMPAIGN_SHIFT_UNDERSTAFFED  managers, once per day 72 h before it, shifts below their minimum
--   CAMPAIGN_SHIFT_OVER_MAX      managers, when a shift goes over its expected maximum
--   CAMPAIGN_JOIN_INVITE         residents near the meeting points, when a manager re-invites
--   CAMPAIGN_SHIFT_CLOSED        volunteers of a shift a manager turned off
-- Rollback: enum values cannot be dropped in Postgres without recreating the type.

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'CAMPAIGN_SHIFT_UNDERSTAFFED';
ALTER TYPE "NotificationKind" ADD VALUE 'CAMPAIGN_SHIFT_OVER_MAX';
ALTER TYPE "NotificationKind" ADD VALUE 'CAMPAIGN_JOIN_INVITE';
ALTER TYPE "NotificationKind" ADD VALUE 'CAMPAIGN_SHIFT_CLOSED';
