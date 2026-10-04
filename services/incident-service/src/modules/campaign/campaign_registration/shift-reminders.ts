import { CAMPAIGN_REGISTRABLE_STATUSES, CAMPAIGN_REMINDER_HOURS } from "@da2/constants";
import prisma from "../../../config/prisma.client";
import { campaignTitleNotificationPayload } from "../campaign-i18n";
import { enqueueWebsiteNotificationsToUsers } from "../notification-jobs.client";
import { localDayMonth, localHourMinute } from "./staffing-shared";

const HOUR_MS = 60 * 60 * 1000;
const [EARLY_HOURS, LATE_HOURS] = CAMPAIGN_REMINDER_HOURS;

/**
 * Spec 3.7: each volunteer is reminded 24 h and 1 h before the gathering time of every day they
 * registered for: the earliest gathering time (or start) among their shifts that day. One
 * reminder per day, whatever the number of shifts. Someone who registers within the last
 * 24 hours only gets the 1-hour one. A reminder is marked on the day's registrations once
 * queued, so a failure is retried on the next sweep. Notification preferences apply
 * (`volunteerRequest`). Returns how many reminders were queued.
 */
export async function sendShiftReminders(now = new Date()): Promise<number> {
  const rows = await prisma.campaignShiftRegistration.findMany({
    where: {
      leftAt: null,
      OR: [{ reminded24hAt: null }, { reminded1hAt: null }],
      shift: {
        minVolunteers: { gt: 0 },
        startAt: { gt: now, lte: new Date(now.getTime() + (EARLY_HOURS + 1) * HOUR_MS) },
      },
      campaign: { deletedAt: null, status: { in: [...CAMPAIGN_REGISTRABLE_STATUSES] } },
    },
    select: {
      id: true,
      userId: true,
      reminded24hAt: true,
      reminded1hAt: true,
      shift: {
        select: {
          dayId: true,
          startAt: true,
          gatherAt: true,
          meetingPoint: { select: { name: true, detailAddress: true, sortOrder: true } },
        },
      },
      campaign: {
        select: { id: true, title: true, titleVi: true, titleEn: true, safetyNotes: true },
      },
    },
    take: 2000,
  });

  const days = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.userId}:${r.shift.dayId}`;
    days.set(key, [...(days.get(key) ?? []), r]);
  }

  let sent = 0;
  for (const group of days.values()) {
    const gatherOf = (r: (typeof group)[number]) => r.shift.gatherAt ?? r.shift.startAt;
    const first = group.reduce((a, b) => (gatherOf(b) < gatherOf(a) ? b : a));
    const gather = gatherOf(first);
    const until = gather.getTime() - now.getTime();
    if (until <= 0) continue;

    // A reminder already sent for one of the day's shifts covers the day.
    const late = until <= LATE_HOURS * HOUR_MS;
    if (late ? group.some((r) => r.reminded1hAt) : group.some((r) => r.reminded24hAt)) continue;
    if (!late && until > EARLY_HOURS * HOUR_MS) continue;

    try {
      const point = first.shift.meetingPoint;
      await enqueueWebsiteNotificationsToUsers({
        kind: "CAMPAIGN_SHIFT_REMINDER",
        userIds: [first.userId],
        payload: {
          campaignId: first.campaign.id,
          hours: String(late ? LATE_HOURS : EARLY_HOURS),
          soon: late ? "1" : "",
          day: localDayMonth(gather),
          gatherTime: localHourMinute(gather),
          meetingPoint: point.name || `#${point.sortOrder + 1}`,
          address: point.detailAddress ?? "",
          safetyNotes: first.campaign.safetyNotes ?? "",
          ...campaignTitleNotificationPayload(first.campaign),
        },
      });
      await prisma.campaignShiftRegistration.updateMany({
        where: { id: { in: group.map((r) => r.id) } },
        // The 1-hour reminder also stands for a 24-hour one that came too late to send.
        data: late ? { reminded1hAt: now, reminded24hAt: first.reminded24hAt ?? now } : { reminded24hAt: now },
      });
      sent += 1;
    } catch (error) {
      console.warn("[campaign] shift reminder failed", {
        userId: first.userId,
        dayId: first.shift.dayId,
        error,
      });
    }
  }
  return sent;
}
