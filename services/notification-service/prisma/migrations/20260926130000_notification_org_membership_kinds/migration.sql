-- Phase 2 membership notifications (docs/ORG_OWNERSHIP_FLOW.md):
--   ORG_INVITATION           email to the invitee (payload.toEmail), accept / decline link
--   ORG_INVITATION_PENDING   website, to members who can approve invitations
--   ORG_INVITATION_REJECTED  website, to the inviter
--   ORG_MEMBERSHIP_CHANGED   website, role changed or removed
-- Rollback: enum values cannot be dropped in Postgres without recreating the type.

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'ORG_INVITATION';
ALTER TYPE "NotificationKind" ADD VALUE 'ORG_INVITATION_PENDING';
ALTER TYPE "NotificationKind" ADD VALUE 'ORG_INVITATION_REJECTED';
ALTER TYPE "NotificationKind" ADD VALUE 'ORG_MEMBERSHIP_CHANGED';
