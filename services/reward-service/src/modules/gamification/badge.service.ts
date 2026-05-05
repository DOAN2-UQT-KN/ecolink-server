import { randomUUID } from "crypto";
import type {
  BadgeCategory,
  BadgeRuleType,
  LeaderboardMetric,
  Prisma,
} from "@prisma/client";
import { Prisma as PrismaClient } from "@prisma/client";
import prisma from "../../config/prisma.client";
import { seasonService } from "./season.service";
import {
  normalizeSlugInput,
  slugifyFromName,
  validateBadgeDefinitionShape,
  validateRewardJson,
} from "./badge-definition.validation";

type RewardJson = {
  discountBps?: number;
  discount_bps?: number;
};

function readDiscountBps(reward: Prisma.JsonValue | null): number {
  if (!reward || typeof reward !== "object" || Array.isArray(reward)) {
    return 0;
  }
  const o = reward as RewardJson;
  const bps = o.discountBps ?? o.discount_bps;
  return typeof bps === "number" && bps >= 0 && bps <= 10000 ? bps : 0;
}

async function allocateUniqueSlug(
  tx: Omit<
    PrismaClient.TransactionClient,
    "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
  >,
  name: string,
  slugInput: string | null | undefined,
): Promise<string> {
  const baseRaw = slugInput?.trim()
    ? normalizeSlugInput(slugInput)
    : slugifyFromName(name);
  if (!baseRaw) {
    throw new Error("badge_slug_empty");
  }
  const stem = baseRaw.slice(0, 128);
  for (let attempt = 0; attempt < 64; attempt++) {
    const suffix = attempt === 0 ? "" : `_${attempt + 1}`;
    const maxStem = Math.max(1, 128 - suffix.length);
    const candidate = `${stem.slice(0, maxStem)}${suffix}`;
    const taken = await tx.badgeDefinition.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!taken) {
      return candidate;
    }
  }
  throw new Error("badge_slug_exhausted");
}

async function touchSlugLockedAt(badgeId: string): Promise<void> {
  await prisma.badgeDefinition.updateMany({
    where: { id: badgeId, slugLockedAt: null },
    data: { slugLockedAt: new Date() },
  });
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
      seasonId ?? (await seasonService.getCurrentSeason())?.id ?? null;
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
      seasonId ?? (await seasonService.getCurrentSeason())?.id ?? undefined;

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
          category: g.badge!.category,
          ruleType: g.badge!.ruleType,
          metric: g.badge!.metric,
          threshold: g.badge!.threshold,
          rankTopN: g.badge!.rankTopN,
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
    slug?: string | null;
    name: string;
    symbol?: string | null;
    category: BadgeCategory;
    ruleType: BadgeRuleType;
    metric: LeaderboardMetric;
    threshold?: number | null;
    rankTopN?: number | null;
    reward?: Prisma.InputJsonValue | null;
    isActive?: boolean;
    publishedAt?: Date | null;
  }) {
    const shapeErr = validateBadgeDefinitionShape({
      category: body.category,
      ruleType: body.ruleType,
      metric: body.metric,
      threshold: body.threshold,
      rankTopN: body.rankTopN,
    });
    if (shapeErr) {
      throw new Error(`badge_validation:${shapeErr}`);
    }
    const rewardErr = validateRewardJson(body.reward ?? undefined);
    if (rewardErr) {
      throw new Error(`badge_validation:${rewardErr}`);
    }

    return prisma.$transaction(async (tx) => {
      const slug = await allocateUniqueSlug(tx, body.name, body.slug);
      const data: Prisma.BadgeDefinitionCreateInput = {
        id: randomUUID(),
        slug,
        name: body.name.trim(),
        symbol:
          body.symbol === undefined
            ? undefined
            : body.symbol === null
              ? null
              : body.symbol.trim() || null,
        category: body.category,
        ruleType: body.ruleType,
        metric: body.metric,
        threshold: body.threshold ?? null,
        rankTopN: body.rankTopN ?? null,
        reward: body.reward ?? undefined,
        isActive: body.isActive ?? true,
      };
      if (body.publishedAt !== undefined) {
        data.publishedAt = body.publishedAt;
        data.slugLockedAt =
          body.publishedAt != null ? new Date() : null;
      }
      return tx.badgeDefinition.create({ data });
    });
  }

  async patchDefinition(
    id: string,
    body: Partial<{
      name: string;
      symbol: string | null;
      category: BadgeCategory;
      ruleType: BadgeRuleType;
      metric: LeaderboardMetric;
      threshold: number | null;
      rankTopN: number | null;
      reward: Prisma.InputJsonValue | null;
      isActive: boolean;
      deletedAt: Date | null;
      publishedAt: Date | null;
    }>,
  ) {
    const current = await prisma.badgeDefinition.findUnique({
      where: { id },
      include: { _count: { select: { grants: true } } },
    });
    if (!current) {
      return null;
    }

    const grantCount = current._count.grants;
    const lockedCore = grantCount > 0;

    if (lockedCore) {
      if (body.ruleType !== undefined && body.ruleType !== current.ruleType) {
        throw new Error("badge_validation:rule_locked_after_grant");
      }
      if (body.metric !== undefined && body.metric !== current.metric) {
        throw new Error("badge_validation:metric_locked_after_grant");
      }
      if (body.category !== undefined && body.category !== current.category) {
        throw new Error("badge_validation:category_locked_after_grant");
      }
      if (
        body.threshold !== undefined &&
        body.threshold !== current.threshold
      ) {
        throw new Error("badge_validation:threshold_locked_after_grant");
      }
      if (body.rankTopN !== undefined && body.rankTopN !== current.rankTopN) {
        throw new Error("badge_validation:rank_top_n_locked_after_grant");
      }
    }

    const category = body.category ?? current.category;
    const ruleType = body.ruleType ?? current.ruleType;
    const metric = body.metric ?? current.metric;
    const threshold =
      body.threshold !== undefined ? body.threshold : current.threshold;
    const rankTopN =
      body.rankTopN !== undefined ? body.rankTopN : current.rankTopN;

    const shapeErr = validateBadgeDefinitionShape({
      category,
      ruleType,
      metric,
      threshold,
      rankTopN,
    });
    if (shapeErr) {
      throw new Error(`badge_validation:${shapeErr}`);
    }

    if (body.reward !== undefined) {
      const merged =
        body.reward === null ? null : (body.reward as Prisma.InputJsonValue);
      const rewardErr = validateRewardJson(merged ?? undefined);
      if (rewardErr) {
        throw new Error(`badge_validation:${rewardErr}`);
      }
    }

    const data: Prisma.BadgeDefinitionUpdateInput = {};
    if (body.name !== undefined) {
      data.name = body.name;
    }
    if (body.symbol !== undefined) {
      data.symbol =
        body.symbol === null ? null : body.symbol.trim() || null;
    }
    if (body.category !== undefined) {
      data.category = body.category;
    }
    if (body.ruleType !== undefined) {
      data.ruleType = body.ruleType;
    }
    if (body.metric !== undefined) {
      data.metric = body.metric;
    }
    if (body.threshold !== undefined) {
      data.threshold = body.threshold;
    }
    if (body.rankTopN !== undefined) {
      data.rankTopN = body.rankTopN;
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
    if (body.publishedAt !== undefined && body.publishedAt != null) {
      data.publishedAt = body.publishedAt;
      if (current.slugLockedAt == null) {
        data.slugLockedAt = new Date();
      }
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
   * Only CRP / VRP user metrics; org aggregate thresholds are evaluated elsewhere.
   */
  async evaluateThresholdBadgesForUser(
    userId: string,
    seasonId: string,
    citizenRp: number,
    volunteerRp: number,
    activityMetrics?: {
      reportUpvotes?: number;
      reportCount?: number;
      campaignCompleted?: number;
    },
  ): Promise<void> {
    const defs = await prisma.badgeDefinition.findMany({
      where: {
        deletedAt: null,
        isActive: true,
        ruleType: "THRESHOLD",
      },
    });

    for (const def of defs) {
      if (def.threshold == null) {
        continue;
      }
      const metricValue =
        def.metric === "CRP"
          ? citizenRp
          : def.metric === "VRP"
            ? volunteerRp
            : def.metric === "REPORT_UPVOTES"
              ? (activityMetrics?.reportUpvotes ?? 0)
              : def.metric === "REPORT_COUNT"
                ? (activityMetrics?.reportCount ?? 0)
                : def.metric === "CAMPAIGN_COMPLETED"
                  ? (activityMetrics?.campaignCompleted ?? 0)
                  : -1;
      const passes = metricValue >= def.threshold;
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
      await touchSlugLockedAt(def.id);
    }
  }

  async evaluateRankBadgesForUser(
    userId: string,
    seasonId: string,
    ranks: Partial<Record<LeaderboardMetric, number>>,
  ): Promise<void> {
    const defs = await prisma.badgeDefinition.findMany({
      where: {
        deletedAt: null,
        isActive: true,
        ruleType: "RANK",
      },
    });
    for (const def of defs) {
      if (def.rankTopN == null) {
        continue;
      }
      const rank = ranks[def.metric];
      if (rank == null || rank > def.rankTopN) {
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
      await touchSlugLockedAt(def.id);
    }
  }
}

export const badgeService = new BadgeService();
