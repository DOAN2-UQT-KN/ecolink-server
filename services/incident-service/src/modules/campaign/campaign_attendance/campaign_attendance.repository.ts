import prisma from "../../../config/prisma.client";

/** Reads of attendance per shift (spec 4.1) for the volunteer lists. */
export class CampaignAttendanceRepository {
  /** Check-in time per `shiftId:userId`. */
  async findCheckInsByShift(campaignId: string, userIds: string[]): Promise<Map<string, Date>> {
    if (userIds.length === 0) return new Map();
    const rows = await prisma.campaignShiftAttendance.findMany({
      where: { campaignId, userId: { in: userIds } },
      select: { shiftId: true, userId: true, checkInAt: true },
    });
    return new Map(rows.map((r) => [`${r.shiftId}:${r.userId}`, r.checkInAt]));
  }

  /** Each person's first check-in in the campaign, any shift. */
  async findCheckedInAtByCampaignAndUserIds(
    campaignId: string,
    userIds: string[],
  ): Promise<Map<string, Date>> {
    if (userIds.length === 0) return new Map();
    const rows = await prisma.campaignShiftAttendance.groupBy({
      by: ["userId"],
      where: { campaignId, userId: { in: userIds } },
      _min: { checkInAt: true },
    });
    return new Map(
      rows.filter((r) => r._min.checkInAt).map((r) => [r.userId, r._min.checkInAt as Date]),
    );
  }
}

export const campaignAttendanceRepository = new CampaignAttendanceRepository();
