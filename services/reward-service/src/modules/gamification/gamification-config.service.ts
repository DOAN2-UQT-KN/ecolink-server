import { randomUUID } from "crypto";
import type { LeaderboardMetric, SeasonKind } from "@prisma/client";
import { Prisma } from "@prisma/client";
import prisma from "../../config/prisma.client";

/** The earning rates in force; every green-point strategy reads these at credit time. */
export type PointRulesSnapshot = {
  id: string;
  campaignCompletionPoints: number;
  baseReportPoint: number;
  reportMilestoneThresholds: number[];
  reportCompletionPoints: number;
};

/** The four admin-editable rates, as saved and as recorded in the history. */
export type PointRulesValues = Omit<PointRulesSnapshot, "id">;

type PointRulesReader = Pick<Prisma.TransactionClient, "gamificationPointRules">;

/** Active rule row (latest effective); pass `tx` so the rate is the one in force at credit time. */
export async function loadActivePointRules(
  db: PointRulesReader,
): Promise<PointRulesSnapshot | null> {
  const row = await db.gamificationPointRules.findFirst({
    where: { isActive: true },
    orderBy: { effectiveFrom: "desc" },
  });
  return row ? { id: row.id, ...pointRulesValues(row) } : null;
}

export function pointRulesValues(row: PointRulesValues): PointRulesValues {
  return {
    campaignCompletionPoints: row.campaignCompletionPoints,
    baseReportPoint: row.baseReportPoint,
    reportMilestoneThresholds: row.reportMilestoneThresholds,
    reportCompletionPoints: row.reportCompletionPoints,
  };
}

/**
 * Field errors for a point-rules save (spec FR-003): rates are integers >= 0, milestones are
 * distinct integers > 0. Empty means valid.
 */
export function validatePointRulesInput(
  body: Record<string, unknown>,
): Array<{ field: string; message: string }> {
  const errors: Array<{ field: string; message: string }> = [];
  const isNonNegativeInt = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
  for (const field of [
    "campaignCompletionPoints",
    "baseReportPoint",
    "reportCompletionPoints",
  ] as const) {
    if (!isNonNegativeInt(body[field])) {
      errors.push({ field, message: `${field} must be an integer >= 0` });
    }
  }
  const thresholds = body.reportMilestoneThresholds;
  if (!Array.isArray(thresholds)) {
    errors.push({
      field: "reportMilestoneThresholds",
      message: "reportMilestoneThresholds must be an array",
    });
  } else if (!thresholds.every((t) => Number.isInteger(t) && t > 0)) {
    errors.push({
      field: "reportMilestoneThresholds",
      message: "Each milestone must be an integer > 0",
    });
  } else if (new Set(thresholds).size !== thresholds.length) {
    errors.push({
      field: "reportMilestoneThresholds",
      message: "Milestones must not repeat",
    });
  }
  return errors;
}

/** Validated input → stored values, milestones ascending. */
export function normalizePointRulesInput(body: PointRulesValues): PointRulesValues {
  return {
    ...pointRulesValues(body),
    reportMilestoneThresholds: [...body.reportMilestoneThresholds].sort((a, b) => a - b),
  };
}

export class GamificationConfigService {
  async getActivePointRules() {
    return prisma.gamificationPointRules.findFirst({
      where: { isActive: true },
      orderBy: { effectiveFrom: "desc" },
    });
  }

  /** Saves the active rule and its history row in one transaction (spec FR-004). */
  async upsertPointRules(body: PointRulesValues, changedBy: string) {
    const values = normalizePointRulesInput(body);
    return prisma.$transaction(async (tx) => {
      const existing = await tx.gamificationPointRules.findFirst({
        where: { isActive: true },
        orderBy: { effectiveFrom: "desc" },
      });
      const saved = existing
        ? await tx.gamificationPointRules.update({
            where: { id: existing.id },
            data: values,
          })
        : await tx.gamificationPointRules.create({
            data: { id: randomUUID(), ...values, isActive: true },
          });
      await tx.gamificationPointRuleHistory.create({
        data: {
          ruleId: saved.id,
          changedBy,
          before: existing
            ? (pointRulesValues(existing) as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          after: values as Prisma.InputJsonValue,
        },
      });
      return saved;
    });
  }

  async listPointRuleHistory(params: { page: number; limit: number }) {
    const [items, total] = await prisma.$transaction([
      prisma.gamificationPointRuleHistory.findMany({
        orderBy: { changedAt: "desc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.gamificationPointRuleHistory.count(),
    ]);
    return { items, total };
  }

  async getActiveSpRules() {
    return prisma.spendablePointRules.findFirst({
      where: { isActive: true },
      orderBy: { effectiveFrom: "desc" },
    });
  }

  async upsertSpRules(body: { expirationDays: number }) {
    const existing = await this.getActiveSpRules();
    if (existing) {
      return prisma.spendablePointRules.update({
        where: { id: existing.id },
        data: { expirationDays: body.expirationDays },
      });
    }
    return prisma.spendablePointRules.create({
      data: {
        id: randomUUID(),
        expirationDays: body.expirationDays,
        isActive: true,
      },
    });
  }

  async listMultiplierRules() {
    return prisma.volunteerOrgMultiplierRule.findMany({
      orderBy: [{ isActive: "desc" }, { priority: "desc" }],
    });
  }

  async upsertMultiplierRule(body: {
    code: string;
    multiplier: string | number;
    priority?: number;
    isActive?: boolean;
  }) {
    const mul =
      typeof body.multiplier === "number"
        ? body.multiplier
        : Number(body.multiplier);

    return prisma.volunteerOrgMultiplierRule.upsert({
      where: { code: body.code.trim() },
      create: {
        id: randomUUID(),
        code: body.code.trim(),
        multiplier: mul,
        priority: body.priority ?? 0,
        isActive: body.isActive ?? true,
      },
      update: {
        multiplier: mul,
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
    });
  }

  async listSeasonScheduleRules() {
    return prisma.seasonScheduleRules.findMany({
      orderBy: { kind: "asc" },
    });
  }

  async upsertSeasonScheduleRule(body: {
    kind: SeasonKind;
    autoRotate?: boolean;
    metadata?: Prisma.InputJsonValue | null;
  }) {
    return prisma.seasonScheduleRules.upsert({
      where: { kind: body.kind },
      create: {
        id: randomUUID(),
        kind: body.kind,
        autoRotate: body.autoRotate ?? true,
        metadata: body.metadata ?? undefined,
      },
      update: {
        ...(body.autoRotate !== undefined
          ? { autoRotate: body.autoRotate }
          : {}),
        ...(body.metadata !== undefined
          ? {
              metadata:
                body.metadata === null
                  ? Prisma.JsonNull
                  : (body.metadata as Prisma.InputJsonValue),
            }
          : {}),
      },
    });
  }

  async listPayoutTiers(seasonId?: string | null) {
    return prisma.seasonLeaderboardPayoutTier.findMany({
      where: seasonId === undefined ? {} : { OR: [{ seasonId }, { seasonId: null }] },
      orderBy: [{ metric: "asc" }, { rankMin: "asc" }],
    });
  }

  async createPayoutTier(body: {
    seasonId?: string | null;
    metric: LeaderboardMetric;
    rankMin: number;
    rankMax: number;
    spAmount: number;
  }) {
    return prisma.seasonLeaderboardPayoutTier.create({
      data: {
        id: randomUUID(),
        seasonId: body.seasonId ?? null,
        metric: body.metric,
        rankMin: body.rankMin,
        rankMax: body.rankMax,
        spAmount: body.spAmount,
      },
    });
  }

  async patchPayoutTier(
    id: string,
    body: Partial<{
      seasonId: string | null;
      metric: LeaderboardMetric;
      rankMin: number;
      rankMax: number;
      spAmount: number;
    }>,
  ) {
    try {
      return await prisma.seasonLeaderboardPayoutTier.update({
        where: { id },
        data: body,
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2025"
      ) {
        return null;
      }
      throw e;
    }
  }

  async deletePayoutTier(id: string): Promise<boolean> {
    try {
      await prisma.seasonLeaderboardPayoutTier.delete({ where: { id } });
      return true;
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2025"
      ) {
        return false;
      }
      throw e;
    }
  }
}

export const gamificationConfigService = new GamificationConfigService();
