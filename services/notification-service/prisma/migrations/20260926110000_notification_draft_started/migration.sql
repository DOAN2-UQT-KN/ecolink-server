-- Mail sent when the OTP opens a new draft application, carrying the link back to the draft
-- editor (the tracking token is issued at that moment, not at submission). Addressed by
-- email only (payload.toEmail), like the rest of the application pipeline.
-- Rollback: enum values cannot be dropped in Postgres without recreating the type.

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'ORG_APPLICATION_DRAFT_STARTED';
