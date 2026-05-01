import { randomUUID } from "crypto";
import type { BadgeRuleType, Prisma } from "@prisma/client";
import { Prisma as PrismaClient } from "@prisma/client";
import prisma from "../../config/prisma.client";
import { seasonService } from "./season.service";

type RewardJson = { discountBps?: number; tier?: number | string };

function readDiscountBps(reward: Prisma.JsonValue | null): number {
  if (!reward || typeof reward !== "object" || Array.isArray(reward)) {
    return 0;
  }
  const bps = (reward as RewardJson).discountBps;
  return typeof bps === "number" && bps >= 0 && bps <= 10000 ? bps : 0;
}

export class BadgeService {
  /**
   * Best store discount (basis points) from active badges for the season — max tier wins.
   */
  async getBestStoreDiscountBps(
    userId: string,
    seasonId?: string,
  ): Promise<number> {
    const sid =
      seasonId ??
      (await seasonService.getCurrentSeason())?.id ??
      null;
    if (!sid) {
      return 0;
    }

    const grants = await prisma.userBadgeGrant.findMany({
      where: { userId, seasonId: sid },
      include: { badge: true },
    });

    let best = 0;
    for (const g of grants) {
      if (!g.badge || g.badge.deletedAt || !g.badge.isActive) {
        continue;
      }
      best = Math.max(best, readDiscountBps(g.badge.reward));
    }
    return best;
  }

  async listMyBadges(userId: string, seasonId?: string) {
    const sid =
      seasonId ??
      (await seasonService.getCurrentSeason())?.id ??
      undefined;

    const where: PrismaClient.UserBadgeGrantWhereInput = { userId };
    if (sid) {
      where.seasonId = sid;
    }

    const grants = await prisma.userBadgeGrant.findMany({
      where,
      orderBy: { grantedAt: "desc" },
      include: {
        badge: true,
        season: true,
      },
    });

    return grants
      .filter((g) => g.badge && !g.badge.deletedAt)
      .map((g) => ({
      id: g.id,
      grantedAt: g.grantedAt.toISOString(),
      metadata: g.metadata,
      season: {
        id: g.season.id,
        label: g.season.label,
        kind: g.season.kind,
        status: g.season.status,
      },
      badge: {
        id: g.badge!.id,
        slug: g.badge!.slug,
        name: g.badge!.name,
        symbol: g.badge!.symbol,
        ruleType: g.badge!.ruleType,
        threshold: g.badge!.threshold,
        rankTopN: g.badge!.rankTopN,
        rankMetric: g.badge!.rankMetric,
        reward: g.badge!.reward,
      },
    }));
  }

  async listDefinitionsAdmin(includeInactive = false) {
    return prisma.badgeDefinition.findMany({
      where: includeInactive ? {} : { deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
  }

  async createDefinition(body: {
    slug: string;
    name: string;
    symbol?: string | null;
    ruleType: BadgeRuleType;
    threshold?: number | null;
    rankTopN?: number | null;
    rankMetric?: import("@prisma/client").LeaderboardMetric | null;
    reward?: Prisma.InputJsonValue | null;
    isActive?: boolean;
  }) {
    return prisma.badgeDefinition.create({
      data: {
        id: randomUUID(),
        slug: body.slug.trim(),
        name: body.name.trim(),
        symbol:
          body.symbol === undefined
            ? undefined
            : body.symbol === null
              ? null
              : body.symbol.trim() || null,
        ruleType: body.ruleType,
        threshold: body.threshold ?? null,
        rankTopN: body.rankTopN ?? null,
        rankMetric: body.rankMetric ?? null,
        reward: body.reward ?? undefined,
        isActive: body.isActive ?? true,
      },
    });
  }

  async patchDefinition(
    id: string,
    body: Partial<{
      name: string;
      symbol: string | null;
      ruleType: BadgeRuleType;
      threshold: number | null;
      rankTopN: number | null;
      rankMetric: import("@prisma/client").LeaderboardMetric | null;
      reward: Prisma.InputJsonValue | null;
      isActive: boolean;
      deletedAt: Date | null;
    }>,
  ) {
    const data: Prisma.BadgeDefinitionUpdateInput = {};
    if (body.name !== undefined) {
      data.name = body.name;
    }
    if (body.symbol !== undefined) {
      data.symbol =
        body.symbol === null ? null : body.symbol.trim() || null;
    }
    if (body.ruleType !== undefined) {
      data.ruleType = body.ruleType;
    }
    if (body.threshold !== undefined) {
      data.threshold = body.threshold;
    }
    if (body.rankTopN !== undefined) {
      data.rankTopN = body.rankTopN;
    }
    if (body.rankMetric !== undefined) {
      data.rankMetric = body.rankMetric;
    }
    if (body.reward !== undefined) {
      data.reward =
        body.reward === null
          ? PrismaClient.JsonNull
          : (body.reward as Prisma.InputJsonValue);
    }
    if (body.isActive !== undefined) {
      data.isActive = body.isActive;
    }
    if (body.deletedAt !== undefined) {
      data.deletedAt = body.deletedAt;
    }

    try {
      return await prisma.badgeDefinition.update({
        where: { id },
        data,
      });
    } catch (e) {
      if (
        e instanceof PrismaClient.PrismaClientKnownRequestError &&
        e.code === "P2025"
      ) {
        return null;
      }
      throw e;
    }
  }

  /**
   * Evaluate threshold badges for a user after RP totals change (called from workers).
   */
  async evaluateThresholdBadgesForUser(
    userId: string,
    seasonId: string,
    citizenRp: number,
    volunteerRp: number,
  ): Promise<void> {
    const defs = await prisma.badgeDefinition.findMany({
      where: {
        deletedAt: null,
        isActive: true,
        ruleType: { in: ["CRP", "VRP"] },
      },
    });

    for (const def of defs) {
      if (def.threshold == null) {
        continue;
      }
      const passes =
        (def.ruleType === "CRP" && citizenRp >= def.threshold) ||
        (def.ruleType === "VRP" && volunteerRp >= def.threshold);
      if (!passes) {
        continue;
      }

      await prisma.userBadgeGrant.upsert({
        where: {
          userId_badgeId_seasonId: {
            userId,
            badgeId: def.id,
            seasonId,
          },
        },
        create: {
          id: randomUUID(),
          userId,
          badgeId: def.id,
          seasonId,
        },
        update: {},
      });
    }
  }
}

export const badgeService = new BadgeService();
