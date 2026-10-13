-- SOS v2: alerts to the campaign team, invites and warnings to "available" volunteers, requests to
-- nearby organizations, admin alerts (medical and hazard also by email), escalations and the
-- notices to the people on their way. Rollback: enum values cannot be dropped in Postgres without
-- recreating the type.

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'SOS_TEAM_ALERT';
ALTER TYPE "NotificationKind" ADD VALUE 'SOS_MEDICAL_ALERT';
ALTER TYPE "NotificationKind" ADD VALUE 'SOS_HELP_INVITE';
ALTER TYPE "NotificationKind" ADD VALUE 'SOS_HAZARD_WARNING';
ALTER TYPE "NotificationKind" ADD VALUE 'SOS_NEARBY_ORG_REQUEST';
ALTER TYPE "NotificationKind" ADD VALUE 'SOS_ADMIN_ALERT';
ALTER TYPE "NotificationKind" ADD VALUE 'SOS_OWNER_ESCALATION';
ALTER TYPE "NotificationKind" ADD VALUE 'SOS_ESCALATED';
ALTER TYPE "NotificationKind" ADD VALUE 'SOS_LOCATION_CHANGED';
ALTER TYPE "NotificationKind" ADD VALUE 'SOS_EXPIRED';
ALTER TYPE "NotificationKind" ADD VALUE 'SOS_NO_LONGER_NEEDED';
ALTER TYPE "NotificationKind" ADD VALUE 'SOS_ABUSE_REVIEW';
