import { Prisma } from "@prisma/client";
import prisma from "../../config/prisma.client";
import { fetchUsersByIds, getUserProfile } from "../../utils/identity-user.client";
import { GreenPointResourceType } from "../green-point/green-point-transaction.constants";
import {
  fetchCampaignsByIds,
  fetchReportsByIds,
} from "../../utils/incident-resource.client";

export class UserPointsService {
  async getPoints(userId: string) {
    const balance = await prisma.userGreenPointBalance.findUnique({
      where: { userId }
    });
    const aggregate = await prisma.greenPointTransaction.aggregate({
      _sum: {
        points: true
      },
      where: {
        userId,
        points: { gt: 0 },
        deletedAt: null
      }
    });

    return {
      balance: balance?.balance ?? 0,
      greenPoints: aggregate._sum.points ?? 0
    };
  }

  async getTransactions(
    userId: string,
    page: number,
    limit: number,
    type?: string,
    sortBy: string = "createdAt",
    sortOrder: string = "desc",
    authorization?: string,
  ) {
    const skip = (page - 1) * limit;
    const where: Prisma.GreenPointTransactionWhereInput = { userId, deletedAt: null };
    if (type) {
      where.type = type;
    }
    const [rows, total] = await Promise.all([
      prisma.greenPointTransaction.findMany({
        where,
        orderBy: { [sortBy]: sortOrder },
        skip,
        take: limit
      }),
      prisma.greenPointTransaction.count({ where })
    ]);

    const campaignIds = [
      ...new Set(
        rows
          .filter((row) => row.resourceType === GreenPointResourceType.CAMPAIGN)
          .map((row) => row.resourceId),
      ),
    ];
    const reportIds = [
      ...new Set(
        rows
          .filter((row) => row.resourceType === GreenPointResourceType.REPORT)
          .map((row) => row.resourceId),
      ),
    ];
    const referralUserIds = [
      ...new Set(
        rows
          .filter((row) => row.resourceType === GreenPointResourceType.USER)
          .map((row) => row.resourceId),
      ),
    ];

    const [campaignMap, reportMap, referralUserMap] = await Promise.all([
      fetchCampaignsByIds(campaignIds, authorization),
      fetchReportsByIds(reportIds, authorization),
      fetchUsersByIds(referralUserIds),
    ]);

    const transactions = rows.map((row) => {
      if (row.resourceType === GreenPointResourceType.CAMPAIGN) {
        return { ...row, resource: campaignMap.get(row.resourceId) ?? null };
      }
      if (row.resourceType === GreenPointResourceType.REPORT) {
        return { ...row, resource: reportMap.get(row.resourceId) ?? null };
      }
      if (row.resourceType === GreenPointResourceType.USER) {
        const profile = getUserProfile(referralUserMap, row.resourceId);
        return {
          ...row,
          resource: profile
            ? {
                id: profile.id,
                name: profile.name,
                avatar: profile.avatar,
                bio: profile.bio,
              }
            : null,
        };
      }
      return { ...row, resource: null };
    });

    return { transactions, total };
  }

  async getLeaderboard(page: number, limit: number) {
    const skip = (page - 1) * limit;
    
    const rows = await prisma.$queryRaw`
      SELECT "user_id" as "userId", SUM("points") as "greenPoints"
      FROM "green_point_transactions"
      WHERE "points" > 0 AND "deleted_at" IS NULL
      GROUP BY "user_id"
      ORDER BY "greenPoints" DESC
      LIMIT ${limit} OFFSET ${skip}
    `;

    const totalRaw = await prisma.$queryRaw`
      SELECT COUNT(DISTINCT "user_id") as "total"
      FROM "green_point_transactions"
      WHERE "points" > 0 AND "deleted_at" IS NULL
    `;
    const total = Number((totalRaw as any)[0]?.total ?? 0);
    const data = rows as any[];

    if (data.length === 0) {
      return { rows: [], total: 0 };
    }

    const userIds = data.map((r) => r.userId);
    const profileMap = await fetchUsersByIds(userIds);

    const enriched = data.map((r) => {
      const profile = getUserProfile(profileMap, r.userId);
      return {
        userId: r.userId,
        greenPoints: Number(r.greenPoints),
        user: profile ? {
          id: profile.id,
          name: profile.name,
          avatar: profile.avatar
        } : null
      };
    });

    return { rows: enriched, total };
  }

  async getLeaderboardMe(userId: string) {
    const rows = await prisma.$queryRaw`
      WITH Leaderboard AS (
        SELECT "user_id" as "userId", SUM("points") as "greenPoints",
               RANK() OVER(ORDER BY SUM("points") DESC) as "rank"
        FROM "green_point_transactions"
        WHERE "points" > 0 AND "deleted_at" IS NULL
        GROUP BY "user_id"
      )
      SELECT * FROM Leaderboard WHERE "userId" = ${userId}::uuid
    `;
    const data = rows as any[];
    if (data.length > 0) {
      return { rank: Number(data[0].rank), greenPoints: Number(data[0].greenPoints) };
    }
    return null;
  }
}

export const userPointsService = new UserPointsService();
