-- Notification kinds for the organization application pipeline.
-- ORG_APPLICATION_OTP and ORG_ACCOUNT_ACTIVATION are addressed by email only: the recipient
-- has no account yet, so they arrive with payload.toEmail instead of a userId.
-- Rollback: enum values cannot be dropped in Postgres without recreating the type.

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'ORG_APPLICATION_OTP';
ALTER TYPE "NotificationKind" ADD VALUE 'ORG_APPLICATION_RECEIVED';
ALTER TYPE "NotificationKind" ADD VALUE 'ORG_APPLICATION_NEEDS_INFO';
ALTER TYPE "NotificationKind" ADD VALUE 'ORG_APPLICATION_REJECTED';
ALTER TYPE "NotificationKind" ADD VALUE 'ORG_ACCOUNT_ACTIVATION';
