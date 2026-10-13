-- Result verification now votes and decides per meeting point (spec "-2"): the reporter's
-- confirmation, the reminder, the admin's flag and the rejection are about a meeting point and
-- its trash points. Renamed in place so notifications already sent keep their kind.

-- AlterEnum
ALTER TYPE "NotificationKind" RENAME VALUE 'CAMPAIGN_TRASH_POINT_CONFIRM_REQUEST' TO 'CAMPAIGN_MEETING_POINT_CONFIRM_REQUEST';
ALTER TYPE "NotificationKind" RENAME VALUE 'CAMPAIGN_TRASH_POINT_CONFIRM_REMINDER' TO 'CAMPAIGN_MEETING_POINT_CONFIRM_REMINDER';
ALTER TYPE "NotificationKind" RENAME VALUE 'CAMPAIGN_TRASH_POINT_FLAGGED' TO 'CAMPAIGN_MEETING_POINT_FLAGGED';
ALTER TYPE "NotificationKind" RENAME VALUE 'CAMPAIGN_TRASH_POINT_REJECTED' TO 'CAMPAIGN_MEETING_POINT_REJECTED';
