import prisma from "../../../config/prisma.client";

/** Asia/Ho_Chi_Minh, no daylight saving. */
const LOCAL_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;

/** "dd/MM" in local time. */
export const localDayMonth = (d: Date) => {
  const iso = new Date(d.getTime() + LOCAL_UTC_OFFSET_MS).toISOString();
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
};

/** "HH:mm" in local time. */
export const localHourMinute = (d: Date) =>
  new Date(d.getTime() + LOCAL_UTC_OFFSET_MS).toISOString().slice(11, 16);

/** The campaign's creator and active managers, the people staffing notices go to. */
export function managerRecipients(campaign: {
  createdBy: string | null;
  campaignManagers: Array<{ userId: string }>;
}): string[] {
  return [
    ...new Set([
      ...(campaign.createdBy ? [campaign.createdBy] : []),
      ...campaign.campaignManagers.map((m) => m.userId),
    ]),
  ];
}

/** What a staffing notice needs to know about a campaign. */
export const STAFFING_CAMPAIGN_SELECT = {
  id: true,
  title: true,
  titleVi: true,
  titleEn: true,
  createdBy: true,
  campaignManagers: { where: { deletedAt: null }, select: { userId: true } },
} as const;

/** Live registrations per shift id. */
export async function countLiveByShift(shiftIds: string[]): Promise<Map<string, number>> {
  if (shiftIds.length === 0) return new Map();
  const groups = await prisma.campaignShiftRegistration.groupBy({
    by: ["shiftId"],
    where: { shiftId: { in: shiftIds }, leftAt: null },
    _count: { _all: true },
  });
  return new Map(groups.map((g) => [g.shiftId, g._count._all]));
}
