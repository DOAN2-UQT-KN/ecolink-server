import { CAMPAIGN_SHIFT_RESULT_REMINDER_HOURS, CampaignStatus } from "@da2/constants";
import prisma from "../../../config/prisma.client";
import { campaignTitleNotificationPayload } from "../campaign-i18n";
import { enqueueWebsiteNotificationsToUsers } from "../notification-jobs.client";
import {
  localDayMonth,
  managerRecipients,
  STAFFING_CAMPAIGN_SELECT,
} from "../campaign_registration/staffing-shared";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Spec 4.2: a shift still waiting for its result 24 h after its (actual) end reminds its leader and
 * the campaign's managers, then again every 24 h while the campaign runs. Marked once queued, so
 * a failure is retried on the next sweep. Bypasses notification preferences. Returns how many
 * shifts were reminded.
 */
export async function sendShiftResultReminders(now = new Date()): Promise<number> {
  const due = new Date(now.getTime() - CAMPAIGN_SHIFT_RESULT_REMINDER_HOURS * HOUR_MS);
  const shifts = await prisma.campaignShift.findMany({
    where: {
      minVolunteers: { gt: 0 },
      result: null,
      OR: [{ endedAt: null, endAt: { lte: due } }, { endedAt: { lte: due } }],
      AND: [{ OR: [{ resultRemindedAt: null }, { resultRemindedAt: { lte: due } }] }],
      campaign: { deletedAt: null, status: CampaignStatus.ACTIVE },
    },
    select: {
      id: true,
      startAt: true,
      leaderUserId: true,
      meetingPoint: { select: { name: true, sortOrder: true } },
      campaign: { select: STAFFING_CAMPAIGN_SELECT },
    },
    orderBy: { startAt: "asc" },
    take: 500,
  });

  let sent = 0;
  for (const shift of shifts) {
    const userIds = [
      ...new Set([...(shift.leaderUserId ? [shift.leaderUserId] : []), ...managerRecipients(shift.campaign)]),
    ];
    try {
      if (userIds.length > 0) {
        const point = shift.meetingPoint;
        await enqueueWebsiteNotificationsToUsers({
          kind: "CAMPAIGN_SHIFT_RESULT_MISSING",
          userIds,
          payload: {
            campaignId: shift.campaign.id,
            shiftId: shift.id,
            day: localDayMonth(shift.startAt),
            meetingPoint: point.name || `#${point.sortOrder + 1}`,
            ...campaignTitleNotificationPayload(shift.campaign),
          },
        });
      }
      await prisma.campaignShift.update({ where: { id: shift.id }, data: { resultRemindedAt: now } });
      sent += 1;
    } catch (error) {
      console.warn("[campaign] shift result reminder failed", { shiftId: shift.id, error });
    }
  }
  return sent;
}
