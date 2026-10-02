import { CAMPAIGN_REGISTRABLE_STATUSES, CAMPAIGN_UNDERSTAFFED_NOTICE_HOURS } from "@da2/constants";
import prisma from "../../../config/prisma.client";
import { campaignTitleNotificationPayload } from "../campaign-i18n";
import { enqueueWebsiteNotificationsToUsers } from "../notification-jobs.client";
import {
  STAFFING_CAMPAIGN_SELECT,
  countLiveByShift,
  localDayMonth,
  localHourMinute,
  managerRecipients,
} from "./staffing-shared";

const HOUR_MS = 60 * 60 * 1000;

const shiftLabel = (s: { startAt: Date; meetingPoint: { name: string | null; sortOrder: number } }) =>
  `${s.meetingPoint.name || `#${s.meetingPoint.sortOrder + 1}`} ${localHourMinute(s.startAt)}`;

/**
 * Spec 3.2: once a day is within `CAMPAIGN_UNDERSTAFFED_NOTICE_HOURS` of its start, managers are
 * told about its shifts still below their minimum, once per day. Days with every shift filled are
 * marked too, so a day is looked at only once. Returns how many days were reported.
 */
export async function sendUnderstaffedAlerts(now = new Date()): Promise<number> {
  const days = await prisma.campaignDay.findMany({
    where: {
      understaffedNotifiedAt: null,
      startAt: { gt: now, lte: new Date(now.getTime() + CAMPAIGN_UNDERSTAFFED_NOTICE_HOURS * HOUR_MS) },
      campaign: { deletedAt: null, status: { in: [...CAMPAIGN_REGISTRABLE_STATUSES] } },
    },
    select: {
      id: true,
      startAt: true,
      campaign: { select: STAFFING_CAMPAIGN_SELECT },
      shifts: {
        where: { minVolunteers: { gt: 0 } },
        orderBy: { startAt: "asc" },
        select: {
          id: true,
          startAt: true,
          minVolunteers: true,
          meetingPoint: { select: { name: true, sortOrder: true } },
        },
      },
    },
    take: 200,
  });

  let reported = 0;
  for (const day of days) {
    try {
      const counts = await countLiveByShift(day.shifts.map((s) => s.id));
      const short = day.shifts.filter((s) => (counts.get(s.id) ?? 0) < s.minVolunteers);
      if (short.length > 0) {
        const recipients = managerRecipients(day.campaign);
        if (recipients.length > 0) {
          await enqueueWebsiteNotificationsToUsers({
            kind: "CAMPAIGN_SHIFT_UNDERSTAFFED",
            userIds: recipients,
            payload: {
              campaignId: day.campaign.id,
              day: localDayMonth(day.startAt),
              shifts: short
                .map((s) => `${shiftLabel(s)}: ${counts.get(s.id) ?? 0}/${s.minVolunteers}`)
                .join(" · "),
              ...campaignTitleNotificationPayload(day.campaign),
            },
          });
        }
        reported += 1;
      }
      await prisma.campaignDay.update({
        where: { id: day.id },
        data: { understaffedNotifiedAt: now },
      });
    } catch (error) {
      // Left unmarked, so the next sweep tries again.
      console.warn("[campaign] understaffed alert failed", { dayId: day.id, error });
    }
  }
  return reported;
}

/**
 * Spec 3.2: a shift going over its expected maximum is reported to managers once; the mark is
 * cleared when it drops back to the maximum, so going over again is reported again. Returns how
 * many shifts were reported.
 */
export async function sendOverMaxAlerts(now = new Date()): Promise<number> {
  const shifts = await prisma.campaignShift.findMany({
    where: {
      maxVolunteers: { not: null },
      minVolunteers: { gt: 0 },
      startAt: { gt: now },
      campaign: { deletedAt: null, status: { in: [...CAMPAIGN_REGISTRABLE_STATUSES] } },
    },
    select: {
      id: true,
      startAt: true,
      maxVolunteers: true,
      overMaxNotifiedAt: true,
      meetingPoint: { select: { name: true, sortOrder: true } },
      campaign: { select: STAFFING_CAMPAIGN_SELECT },
    },
    take: 1000,
  });
  const counts = await countLiveByShift(shifts.map((s) => s.id));

  let reported = 0;
  for (const shift of shifts) {
    const registered = counts.get(shift.id) ?? 0;
    const over = registered > (shift.maxVolunteers ?? Infinity);
    try {
      if (over && !shift.overMaxNotifiedAt) {
        const recipients = managerRecipients(shift.campaign);
        if (recipients.length > 0) {
          await enqueueWebsiteNotificationsToUsers({
            kind: "CAMPAIGN_SHIFT_OVER_MAX",
            userIds: recipients,
            payload: {
              campaignId: shift.campaign.id,
              day: localDayMonth(shift.startAt),
              shift: shiftLabel(shift),
              registered: String(registered),
              max: String(shift.maxVolunteers),
              ...campaignTitleNotificationPayload(shift.campaign),
            },
          });
        }
        await prisma.campaignShift.update({
          where: { id: shift.id },
          data: { overMaxNotifiedAt: now },
        });
        reported += 1;
      } else if (!over && shift.overMaxNotifiedAt) {
        await prisma.campaignShift.update({
          where: { id: shift.id },
          data: { overMaxNotifiedAt: null },
        });
      }
    } catch (error) {
      console.warn("[campaign] over-max alert failed", { shiftId: shift.id, error });
    }
  }
  return reported;
}
