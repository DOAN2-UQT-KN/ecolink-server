import type { BadgeDefinition, BadgeScope, Prisma } from "@prisma/client";
import prisma from "../../config/prisma.client";
import { seasonService } from "./season.service";

export type LogicalOperator = "AND" | "OR";

export type AggregationOp = "COUNT" | "SUM";

export type ComparisonOperator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq";

export type RuleTarget =
  | "orders"
  | "reviews"
  | "reports"
  | "votes"
  // Existing gamification data sources – easy to extend.
  | "user_point_transactions";

export interface RuleLeafCondition {
  target: RuleTarget;
  agg: AggregationOp;
  field: string;
  operator: ComparisonOperator;
  value: number;
}

export interface RuleGroupCondition {
  logical_operator: LogicalOperator;
  conditions: RuleCondition[];
}

export type RuleCondition = RuleLeafCondition | RuleGroupCondition;

export interface BadgeRulesConfigAst extends RuleGroupCondition {}

type SeasonWindow = {
  id: string;
  startsAt: Date;
  endsAt: Date;
};

function isGroup(node: RuleCondition): node is RuleGroupCondition {
  return (node as RuleGroupCondition).conditions !== undefined;
}

function compareNumeric(
  left: number,
  op: ComparisonOperator,
  right: number,
): boolean {
  switch (op) {
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    case "eq":
      return left === right;
    case "neq":
      return left !== right;
  }
}

async function getSeasonWindowForScope(
  scope: BadgeScope,
  explicitSeasonId?: string | null,
): Promise<SeasonWindow | null> {
  if (scope === "LIFETIME") {
    return null;
  }

  if (explicitSeasonId) {
    const s = await prisma.season.findUnique({
      where: { id: explicitSeasonId },
      select: { id: true, startsAt: true, endsAt: true },
    });
    if (!s) return null;
    return { id: s.id, startsAt: s.startsAt, endsAt: s.endsAt };
  }

  const current = await seasonService.getCurrentSeason();
  if (!current) {
    return null;
  }
  return {
    id: current.id,
    startsAt: new Date(current.startsAt),
    endsAt: new Date(current.endsAt),
  };
}

async function getLastGrant(
  userId: string,
  badgeId: string,
  seasonId: string | null,
): Promise<{ grantedAt: Date } | null> {
  const where: Prisma.UserBadgeGrantWhereInput = {
    userId,
    badgeId,
  };
  if (seasonId !== null) {
    where.seasonId = seasonId;
  }

  const last = await prisma.userBadgeGrant.findFirst({
    where,
    orderBy: { grantedAt: "desc" },
    select: { grantedAt: true },
  });
  return last ?? null;
}

async function countGrantsForUserBadge(
  userId: string,
  badgeId: string,
  seasonId: string | null,
): Promise<number> {
  const where: Prisma.UserBadgeGrantWhereInput = {
    userId,
    badgeId,
  };
  if (seasonId !== null) {
    where.seasonId = seasonId;
  }
  return prisma.userBadgeGrant.count({ where });
}

async function evaluateLeafCondition(
  userId: string,
  node: RuleLeafCondition,
  _: BadgeScope,
  seasonWindow: SeasonWindow | null,
  repeatWindowStart: Date | null,
): Promise<boolean> {
  const { target, agg, field, operator, value } = node;

  // Common time window for seasonal + repeatable badges.
  const timeFilter: { gte?: Date; lt?: Date } = {};
  if (seasonWindow) {
    timeFilter.gte = seasonWindow.startsAt;
    timeFilter.lt = seasonWindow.endsAt;
  }
  if (
    repeatWindowStart &&
    (!timeFilter.gte || repeatWindowStart > timeFilter.gte)
  ) {
    timeFilter.gte = repeatWindowStart;
  }

  let metric = 0;

  switch (target) {
    case "user_point_transactions": {
      const where: Prisma.UserPointTransactionWhereInput = {
        userId,
      };
      if (timeFilter.gte || timeFilter.lt) {
        where.createdAt = {};
        if (timeFilter.gte) {
          where.createdAt.gte = timeFilter.gte;
        }
        if (timeFilter.lt) {
          where.createdAt.lt = timeFilter.lt;
        }
      }

      if (agg === "COUNT") {
        metric = await prisma.userPointTransaction.count({ where });
      } else if (agg === "SUM") {
        const aggregate = await prisma.userPointTransaction.aggregate({
          where,
          _sum: {
            [field]: true,
          } as unknown as Prisma.UserPointTransactionSumAggregateInputType,
        });
        const raw = (aggregate._sum as Record<string, unknown>)[field];
        metric = typeof raw === "number" ? raw : 0;
      }
      break;
    }

    // Placeholders for future targets. They intentionally return false
    // until concrete Prisma models and mappings are added.
    case "orders":
    case "reviews":
    case "reports":
    case "votes": {
      return false;
    }
  }

  return compareNumeric(metric, operator, value);
}

async function evaluateNode(
  userId: string,
  node: RuleCondition,
  scope: BadgeScope,
  seasonWindow: SeasonWindow | null,
  repeatWindowStart: Date | null,
  depth: number,
  maxDepth: number,
): Promise<boolean> {
  if (depth > maxDepth) {
    // Defensive guard against pathological / cyclic JSON.
    throw new Error("badge_rules_max_depth_exceeded");
  }

  if (isGroup(node)) {
    const op = node.logical_operator ?? "AND";
    if (!Array.isArray(node.conditions) || node.conditions.length === 0) {
      // Empty groups are treated as neutral (true) for AND/OR.
      return true;
    }
    if (op === "AND") {
      for (const child of node.conditions) {
        const childResult = await evaluateNode(
          userId,
          child,
          scope,
          seasonWindow,
          repeatWindowStart,
          depth + 1,
          maxDepth,
        );
        if (!childResult) {
          return false;
        }
      }
      return true;
    } else {
      for (const child of node.conditions) {
        const childResult = await evaluateNode(
          userId,
          child,
          scope,
          seasonWindow,
          repeatWindowStart,
          depth + 1,
          maxDepth,
        );
        if (childResult) {
          return true;
        }
      }
      return false;
    }
  }

  return evaluateLeafCondition(
    userId,
    node,
    scope,
    seasonWindow,
    repeatWindowStart,
  );
}

export class BadgeRuleEvaluator {
  private static readonly MAX_DEPTH = 32;

  /**
   * Evaluate whether a badge's rulesConfig passes for a given user.
   *
   * Handles:
   * - Lifetime vs seasonal scopes (using Season window when applicable)
   * - Repeatable badges (data considered only after last grant)
   * - Max grants per user
   * - Cooldown between grants
   */
  static async evaluateBadge(
    userId: string,
    badge: BadgeDefinition,
    options?: { seasonId?: string | null },
  ): Promise<boolean> {
    if (!badge.rulesConfig) {
      return false;
    }

    const rawConfig = badge.rulesConfig as unknown;
    if (typeof rawConfig !== "object" || rawConfig === null) {
      throw new Error("badge_rules_config_invalid");
    }

    const config = rawConfig as BadgeRulesConfigAst;

    const seasonWindow = await getSeasonWindowForScope(
      badge.scope,
      options?.seasonId ?? null,
    );

    const effectiveSeasonId =
      badge.scope === "SEASON" ? (seasonWindow?.id ?? null) : null;

    // Max grants per user check.
    if (badge.maxGrantsPerUser != null) {
      const grantCount = await countGrantsForUserBadge(
        userId,
        badge.id,
        effectiveSeasonId,
      );
      if (grantCount >= badge.maxGrantsPerUser) {
        return false;
      }
    } else if (!badge.isRepeatable) {
      // Non-repeatable: short-circuit if any grant exists.
      const grantCount = await countGrantsForUserBadge(
        userId,
        badge.id,
        effectiveSeasonId,
      );
      if (grantCount > 0) {
        return false;
      }
    }

    const lastGrant = await getLastGrant(userId, badge.id, effectiveSeasonId);

    // Cooldown handling.
    if (lastGrant && badge.cooldownSeconds > 0) {
      const nextAllowed =
        lastGrant.grantedAt.getTime() + badge.cooldownSeconds * 1000;
      if (Date.now() < nextAllowed) {
        return false;
      }
    }

    // Repeatable logic option A:
    // Only consider data accumulated after the last successful grant.
    const repeatWindowStart =
      badge.isRepeatable && lastGrant ? lastGrant.grantedAt : null;

    return evaluateNode(
      userId,
      config,
      badge.scope,
      seasonWindow,
      repeatWindowStart,
      0,
      this.MAX_DEPTH,
    );
  }
}
