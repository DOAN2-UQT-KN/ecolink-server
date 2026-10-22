import { Prisma } from "@prisma/client";
import prisma from "../../config/prisma.client";
import { fetchUsersByIds, getUserProfile } from "../../utils/identity-user.client";
import { getBalance, getEarnedTotal, getExpiringSoon } from "../green-point/green-point-lot.util";
import type { MyPointsResponse } from "./user-points.dto";
import { GreenPointResourceType, GreenPointTransactionType } from "../green-point/green-point-transaction.constants";
import {
  fetchCampaignsByIds,
  fetchReportsByIds,
} from "../../utils/incident-resource.client";

export class UserPointsService {
  async getPoints(userId: string): Promise<MyPointsResponse> {
    const now = new Date();
    const [balance, expiringSoon, earnedTotal] = await Promise.all([
      getBalance(prisma, userId, now),
      getExpiringSoon(prisma, userId, now),
      getEarnedTotal(prisma, userId),
    ]);
    return {
      balance,
      earnedTotal,
      expiringSoon: {
        amount: expiringSoon.amount,
        earliestAt: expiringSoon.earliestAt?.toISOString() ?? null,
      },
      // Legacy fields for clients older than spec 014; removed in the cleanup release.
      spendablePoints: balance,
      greenPoints: balance,
      greenPointsEarnedTotal: earnedTotal,
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
      const normalizedType = type.trim().toLowerCase();
      if (normalizedType === "earned") {
        where.points = { gt: 0 };
      } else if (normalizedType === "spent") {
        where.points = { lt: 0 };
      } else {
        where.type = type;
      }
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
          .filter((row) => row.resourceType === GreenPointResourceType.USER && row.type !== GreenPointTransactionType.MIGRATION_ADJUST)
          .map((row) => row.resourceId),
      ),
    ];
    const giftRedemptionIds = [
      ...new Set(
        rows
          .filter((row) => row.resourceType === GreenPointResourceType.GIFT_REDEMPTION)
          .map((row) => row.resourceId),
      ),
    ];

    const [campaignMap, reportMap, referralUserMap, giftRedemptionMap] = await Promise.all([
      fetchCampaignsByIds(campaignIds, authorization),
      fetchReportsByIds(reportIds, authorization),
      fetchUsersByIds(referralUserIds),
      (async () => {
        const out = new Map<string, Record<string, unknown>>();
        if (giftRedemptionIds.length === 0) {
          return out;
        }
        const rows = await prisma.giftRedemption.findMany({
          where: { id: { in: giftRedemptionIds } },
          include: { gift: true },
        });
        for (const redemption of rows) {
          out.set(redemption.id, {
            id: redemption.id,
            giftId: redemption.giftId,
            greenPointsSpent: redemption.greenPointsSpent,
            quantity: redemption.quantity,
            createdAt: redemption.createdAt.toISOString(),
            gift: redemption.gift
              ? {
                  id: redemption.gift.id,
                  name: redemption.gift.name,
                  description: redemption.gift.description,
                  mediaId: redemption.gift.mediaId,
                  greenPoints: redemption.gift.greenPoints,
                }
              : null,
          });
        }
        return out;
      })(),
    ]);

    const transactions = rows.map((row) => {
      if (row.resourceType === GreenPointResourceType.CAMPAIGN) {
        return { ...row, resource: campaignMap.get(row.resourceId) ?? null };
      }
      if (row.resourceType === GreenPointResourceType.REPORT) {
        return { ...row, resource: reportMap.get(row.resourceId) ?? null };
      }
      if (row.resourceType === GreenPointResourceType.USER && row.type !== GreenPointTransactionType.MIGRATION_ADJUST) {
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
      if (row.resourceType === GreenPointResourceType.GIFT_REDEMPTION) {
        return { ...row, resource: giftRedemptionMap.get(row.resourceId) ?? null };
      }
      return { ...row, resource: null };
    });

    return { transactions, total };
  }
}

export const userPointsService = new UserPointsService();
