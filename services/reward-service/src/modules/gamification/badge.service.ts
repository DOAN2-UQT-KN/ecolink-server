import { randomUUID } from "crypto";
import type { BadgeCategory, BadgeScope, Prisma } from "@prisma/client";
import { Prisma as PrismaClient } from "@prisma/client";
import prisma from "../../config/prisma.client";
import { seasonService } from "./season.service";
import {
  normalizeSlugInput,
  slugifyFromName,
  validateBadgeDefinitionShape,
  validateRewardJson,
} from "./badge-definition.validation";
import { BadgeRuleEvaluator } from "./badge-rule-evaluator.service";

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
        season: g.season
          ? {
              id: g.season.id,
              label: g.season.label,
              kind: g.season.kind,
              status: g.season.status,
            }
          : null,
        badge: {
          id: g.badge!.id,
          slug: g.badge!.slug,
          name: g.badge!.name,
          symbol: g.badge!.symbol,
          category: g.badge!.category,
          scope: g.badge!.scope,
          isRepeatable: g.badge!.isRepeatable,
          maxGrantsPerUser: g.badge!.maxGrantsPerUser,
          cooldownSeconds: g.badge!.cooldownSeconds,
          rulesConfig: g.badge!.rulesConfig as Prisma.JsonValue | null,
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
    scope?: BadgeScope;
    isRepeatable?: boolean;
    maxGrantsPerUser?: number | null;
    cooldownSeconds?: number;
    rulesConfig?: Prisma.InputJsonValue | null;
    reward?: Prisma.InputJsonValue | null;
    isActive?: boolean;
    publishedAt?: Date | null;
  }) {
    const shapeErr = validateBadgeDefinitionShape({
      category: body.category,
      scope: body.scope ?? "SEASON",
      isRepeatable: body.isRepeatable ?? false,
      maxGrantsPerUser: body.maxGrantsPerUser ?? null,
      cooldownSeconds: body.cooldownSeconds ?? 0,
      rulesConfig: body.rulesConfig ?? null,
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
        scope: body.scope ?? "SEASON",
        isRepeatable: body.isRepeatable ?? false,
        maxGrantsPerUser: body.maxGrantsPerUser ?? null,
        cooldownSeconds: body.cooldownSeconds ?? 0,
        rulesConfig:
          body.rulesConfig === undefined
            ? undefined
            : (body.rulesConfig as Prisma.InputJsonValue),
        reward: body.reward ?? undefined,
        isActive: body.isActive ?? true,
      };
      if (body.publishedAt !== undefined) {
        data.publishedAt = body.publishedAt;
        data.slugLockedAt = body.publishedAt != null ? new Date() : null;
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
      scope: BadgeScope;
      isRepeatable: boolean;
      maxGrantsPerUser: number | null;
      cooldownSeconds: number;
      rulesConfig: Prisma.InputJsonValue | null;
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
      if (body.category !== undefined && body.category !== current.category) {
        throw new Error("badge_validation:category_locked_after_grant");
      }
      if (body.scope !== undefined && body.scope !== current.scope) {
        throw new Error("badge_validation:scope_locked_after_grant");
      }
    }

    const category = body.category ?? current.category;
    const scope = body.scope ?? current.scope;
    const isRepeatable =
      body.isRepeatable !== undefined ? body.isRepeatable : current.isRepeatable;
    const maxGrantsPerUser =
      body.maxGrantsPerUser !== undefined
        ? body.maxGrantsPerUser
        : current.maxGrantsPerUser;
    const cooldownSeconds =
      body.cooldownSeconds !== undefined
        ? body.cooldownSeconds
        : current.cooldownSeconds;
    const rulesConfig =
      body.rulesConfig !== undefined
        ? (body.rulesConfig as Prisma.InputJsonValue | null)
        : (current.rulesConfig as Prisma.InputJsonValue | null);

    const shapeErr = validateBadgeDefinitionShape({
      category,
      scope,
      isRepeatable,
      maxGrantsPerUser,
      cooldownSeconds,
      rulesConfig,
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
      data.symbol = body.symbol === null ? null : body.symbol.trim() || null;
    }
    if (body.category !== undefined) {
      data.category = body.category;
    }
    if (body.scope !== undefined) {
      data.scope = body.scope;
    }
    if (body.isRepeatable !== undefined) {
      data.isRepeatable = body.isRepeatable;
    }
    if (body.maxGrantsPerUser !== undefined) {
      data.maxGrantsPerUser = body.maxGrantsPerUser;
    }
    if (body.cooldownSeconds !== undefined) {
      data.cooldownSeconds = body.cooldownSeconds;
    }
    if (body.rulesConfig !== undefined) {
      data.rulesConfig =
        body.rulesConfig === null
          ? PrismaClient.JsonNull
          : (body.rulesConfig as Prisma.InputJsonValue);
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
   * Evaluate a single badge definition for a user using the JSON rules engine.
   * This does not create a grant; callers can decide whether and how to persist.
   */
  async evaluateBadge(userId: string, badgeId: string, seasonId?: string) {
    const badge = await prisma.badgeDefinition.findUnique({
      where: { id: badgeId },
    });
    if (!badge || badge.deletedAt || !badge.isActive) {
      return false;
    }
    const passes = await BadgeRuleEvaluator.evaluateBadge(userId, badge, {
      seasonId: seasonId ?? null,
    });
    if (passes) {
      await touchSlugLockedAt(badge.id);
    }
    return passes;
  }
}

export const badgeService = new BadgeService();
