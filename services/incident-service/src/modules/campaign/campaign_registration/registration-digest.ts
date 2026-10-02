import { CAMPAIGN_REGISTRATION_DIGEST_HOUR } from "@da2/constants";
import prisma from "../../../config/prisma.client";
import { campaignTitleNotificationPayload } from "../campaign-i18n";
import { enqueueWebsiteNotificationsToUsers } from "../notification-jobs.client";
import { STAFFING_CAMPAIGN_SELECT, localDayMonth, managerRecipients } from "./staffing-shared";

/** Asia/Ho_Chi_Minh, no daylight saving. */
const LOCAL_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function digestHour(): number {
  const fromEnv = Number(process.env.CAMPAIGN_REGISTRATION_DIGEST_HOUR);
  return Number.isInteger(fromEnv) && fromEnv >= 0 && fromEnv <= 23
    ? fromEnv
    : CAMPAIGN_REGISTRATION_DIGEST_HOUR;
}

/** Today's digest time (local `digestHour()`:00) as a UTC instant. */
export function digestCutoff(now: Date, hour = digestHour()): Date {
  const local = now.getTime() + LOCAL_UTC_OFFSET_MS;
  const localMidnight = Math.floor(local / DAY_MS) * DAY_MS;
  return new Date(localMidnight + hour * 60 * 60 * 1000 - LOCAL_UTC_OFFSET_MS);
}


/**
 * Managers hear about registrations once a day, not per registration (spec 3.1): after the
 * digest hour, every campaign with live registrations made before it and not yet counted gets
 * one notification per manager, with the count per campaign day. Registrations made after the
 * cutoff wait for tomorrow's digest; ones left meanwhile are not counted. Returns how many
 * campaigns were notified.
 */
export async function sendRegistrationDigests(now = new Date()): Promise<number> {
  const cutoff = digestCutoff(now);
  if (now.getTime() < cutoff.getTime()) return 0;

  const rows = await prisma.campaignShiftRegistration.findMany({
    where: {
      leftAt: null,
      managerNotifiedAt: null,
      createdAt: { lt: cutoff },
      campaign: { deletedAt: null },
    },
    select: {
      id: true,
      campaignId: true,
      shift: { select: { day: { select: { startAt: true } } } },
    },
    take: 5000,
  });
  if (rows.length === 0) return 0;

  const byCampaign = new Map<string, typeof rows>();
  for (const r of rows) {
    byCampaign.set(r.campaignId, [...(byCampaign.get(r.campaignId) ?? []), r]);
  }

  let sent = 0;
  for (const [campaignId, regs] of byCampaign) {
    try {
      const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: STAFFING_CAMPAIGN_SELECT,
      });
      const ids = regs.map((r) => r.id);
      if (!campaign) continue;
      const recipients = managerRecipients(campaign);

      const perDay = new Map<number, number>();
      for (const r of regs) {
        const t = r.shift.day.startAt.getTime();
        perDay.set(t, (perDay.get(t) ?? 0) + 1);
      }
      const breakdown = [...perDay.entries()]
        .sort(([a], [b]) => a - b)
        .map(([t, n]) => `${localDayMonth(new Date(t))}: +${n}`)
        .join(" · ");

      if (recipients.length > 0) {
        await enqueueWebsiteNotificationsToUsers({
          kind: "CAMPAIGN_REGISTRATION_DIGEST",
          userIds: recipients,
          payload: {
            campaignId,
            total: String(regs.length),
            breakdown,
            ...campaignTitleNotificationPayload(campaign),
          },
        });
      }
      await prisma.campaignShiftRegistration.updateMany({
        where: { id: { in: ids } },
        data: { managerNotifiedAt: now },
      });
      sent += 1;
    } catch (error) {
      // Left unmarked, so the next sweep tries again.
      console.warn("[campaign] registration digest failed", { campaignId, error });
    }
  }
  return sent;
}
