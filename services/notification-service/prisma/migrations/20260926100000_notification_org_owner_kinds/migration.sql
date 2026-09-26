-- Multi-owner organization applications (docs/ORG_OWNERSHIP_FLOW.md).
-- The activation mail is no longer for a dedicated ORG login but for any owner who had no
-- account, so ORG_ACCOUNT_ACTIVATION is renamed. The new kinds are addressed by email only
-- (payload.toEmail), like the rest of the application pipeline.
-- Rollback: enum values cannot be dropped in Postgres without recreating the type.

-- AlterEnum
ALTER TYPE "NotificationKind" RENAME VALUE 'ORG_ACCOUNT_ACTIVATION' TO 'ACCOUNT_ACTIVATION';
ALTER TYPE "NotificationKind" ADD VALUE 'ORG_OWNER_CONFIRMATION_REQUEST';
ALTER TYPE "NotificationKind" ADD VALUE 'ORG_OWNER_DECLINED';
ALTER TYPE "NotificationKind" ADD VALUE 'ORG_OWNER_CONFIRMATION_EXPIRED';
ALTER TYPE "NotificationKind" ADD VALUE 'ORG_APPLICATION_WITHDRAWN_NOTICE';
ALTER TYPE "NotificationKind" ADD VALUE 'ORG_OWNER_ATTACHED';
