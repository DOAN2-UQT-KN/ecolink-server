-- Spec 3.4 campaign team notices (website):
--   CAMPAIGN_CREATOR_TRANSFERRED   the creator left the organization; the longest-standing owner
--                                  takes over (told separately), the other managers are told
--   CAMPAIGN_SHIFT_LEADER_REMOVED  managers, when shifts lose their leader because that person
--                                  left the organization or is no longer on the team
-- Rollback: enum values cannot be dropped in Postgres without recreating the type.

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'CAMPAIGN_CREATOR_TRANSFERRED';
ALTER TYPE "NotificationKind" ADD VALUE 'CAMPAIGN_SHIFT_LEADER_REMOVED';
