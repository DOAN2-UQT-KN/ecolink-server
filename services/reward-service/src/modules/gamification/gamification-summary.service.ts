import prisma from "../../config/prisma.client";
import { getSpendableSpBalance } from "./sp-wallet.util";
import { seasonService } from "./season.service";

export class GamificationSummaryService {
  async getSummaryForUser(userId: string) {
    const season = await seasonService.getCurrentSeason();

    let citizenRp = 0;
    let volunteerRp = 0;

    if (season) {
      const totals = await prisma.userSeasonRpTotal.findUnique({
        where: {
          userId_seasonId: { userId, seasonId: season.id },
        },
      });
      citizenRp = totals?.citizenRp ?? 0;
      volunteerRp = totals?.volunteerRp ?? 0;
    }

    const now = new Date();
    const spendableSp = await prisma.$transaction((tx) =>
      getSpendableSpBalance(tx, userId, now),
    );

    const nextExpiry = await prisma.userSpWalletEntry.findFirst({
      where: {
        userId,
        remaining: { gt: 0 },
        expiresAt: { gte: now },
      },
      orderBy: { expiresAt: "asc" },
      select: { expiresAt: true },
    });

    const legacyGreen = await prisma.userGreenPointBalance.findUnique({
      where: { userId },
    });

    return {
      season,
      rankingPoints: {
        citizenRp,
        volunteerRp,
        totalRp: citizenRp + volunteerRp,
      },
      spendablePoints: {
        balance: spendableSp,
        nextExpiresAt: nextExpiry?.expiresAt.toISOString() ?? null,
      },
      legacyGreenPointsBalance: legacyGreen?.balance ?? 0,
    };
  }

  async listPointTransactions(
    userId: string,
    page: number,
    limit: number,
    kind?: string,
  ) {
    const skip = (page - 1) * limit;
    const where: {
      userId: string;
      kind?: import("@prisma/client").PointKind;
    } = { userId };
    if (kind && ["CRP", "VRP", "SP"].includes(kind)) {
      where.kind = kind as import("@prisma/client").PointKind;
    }

    const [rows, total] = await Promise.all([
      prisma.userPointTransaction.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.userPointTransaction.count({ where }),
    ]);

    const transactions = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      amount: r.amount,
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      seasonId: r.seasonId,
      metadata: r.metadata,
      idempotencyKey: r.idempotencyKey,
      createdAt: r.createdAt.toISOString(),
    }));

    return { transactions, total, page, limit };
  }

  /**
   * Per-season breakdown: CRP / VRP from `user_season_rp_totals`; SP = net sum of SP ledger
   * rows with `created_at` in [season.startsAt, season.endsAt] (credits +, debits −).
   */
  async getPointsBySeason(userId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;
    const [seasons, total] = await Promise.all([
      prisma.season.findMany({
        orderBy: { startsAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.season.count(),
    ]);

    const rows = await Promise.all(
      seasons.map(async (season) => {
        const [rp, spAgg] = await Promise.all([
          prisma.userSeasonRpTotal.findUnique({
            where: {
              userId_seasonId: { userId, seasonId: season.id },
            },
          }),
          prisma.userPointTransaction.aggregate({
            where: {
              userId,
              kind: "SP",
              createdAt: {
                gte: season.startsAt,
                lte: season.endsAt,
              },
            },
            _sum: { amount: true },
          }),
        ]);

        return {
          seasonId: season.id,
          label: season.label,
          kind: season.kind,
          status: season.status,
          startsAt: season.startsAt.toISOString(),
          endsAt: season.endsAt.toISOString(),
          crp: rp?.citizenRp ?? 0,
          vrp: rp?.volunteerRp ?? 0,
          sp: spAgg._sum.amount ?? 0,
        };
      }),
    );

    return { seasons: rows, total, page, limit };
  }
}

export const gamificationSummaryService = new GamificationSummaryService();
