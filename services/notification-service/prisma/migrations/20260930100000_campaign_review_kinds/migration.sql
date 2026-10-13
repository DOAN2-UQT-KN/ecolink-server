-- Campaign review notifications (Đặc tả luồng chiến dịch, giai đoạn 1–2):
--   CAMPAIGN_PENDING_REVIEW      website, to platform admins when a campaign is sent for review
--   CAMPAIGN_APPROVED            website, to the organization's owners, managers and members
--   CAMPAIGN_REVISION_REQUESTED  website, to the creator and owners, with the admin's reason
--   CAMPAIGN_BLOCKED             website, to the creator and owners, with the admin's reason
--   CAMPAIGN_EXPIRED             website, to the creator when review never finished in time
-- Rollback: enum values cannot be dropped in Postgres without recreating the type.

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'CAMPAIGN_PENDING_REVIEW';
ALTER TYPE "NotificationKind" ADD VALUE 'CAMPAIGN_APPROVED';
ALTER TYPE "NotificationKind" ADD VALUE 'CAMPAIGN_REVISION_REQUESTED';
ALTER TYPE "NotificationKind" ADD VALUE 'CAMPAIGN_BLOCKED';
ALTER TYPE "NotificationKind" ADD VALUE 'CAMPAIGN_EXPIRED';
