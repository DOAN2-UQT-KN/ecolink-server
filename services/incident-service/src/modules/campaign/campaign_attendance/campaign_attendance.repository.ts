import prisma from "../../../config/prisma.client";

export class CampaignAttendanceRepository {
  async createCheckIn(campaignId: string, userId: string) {
    return prisma.campaignAttendanceCheckIn.create({
      data: { campaignId, userId },
    });
  }

  async findByCampaignAndUser(campaignId: string, userId: string) {
    return prisma.campaignAttendanceCheckIn.findUnique({
      where: {
        campaignId_userId: { campaignId, userId },
      },
    });
  }

  async findUserIdsByCampaignId(campaignId: string): Promise<string[]> {
    const rows = await prisma.campaignAttendanceCheckIn.findMany({
      where: { campaignId },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  async findCheckedInAtByCampaignAndUserIds(
    campaignId: string,
    userIds: string[],
  ): Promise<Map<string, Date>> {
    if (userIds.length === 0) {
      return new Map();
    }
    const rows = await prisma.campaignAttendanceCheckIn.findMany({
      where: { campaignId, userId: { in: userIds } },
      select: { userId: true, checkedInAt: true },
    });
    return new Map(rows.map((r) => [r.userId, r.checkedInAt]));
  }
}

export const campaignAttendanceRepository = new CampaignAttendanceRepository();
