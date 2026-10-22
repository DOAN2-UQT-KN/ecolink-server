import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import prisma from "../../config/prisma.client";

/** The earning rates in force; every green-point strategy reads these at credit time. */
export type PointRulesSnapshot = {
  id: string;
  campaignCompletionPoints: number;
  baseReportPoint: number;
  reportMilestoneThresholds: number[];
  reportCompletionPoints: number;
  pointExpirationDays: number;
};

/** The admin-editable rules, as saved and as recorded in the history. */
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
    pointExpirationDays: row.pointExpirationDays,
  };
}

/**
 * Field errors for a point-rules save (spec 013 FR-003, 014 FR-050): rates are integers >= 0,
 * milestones are distinct integers > 0, point expiry is an integer >= 1 day. Empty means valid.
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
  const days = body.pointExpirationDays;
  if (!Number.isInteger(days) || (days as number) < 1) {
    errors.push({
      field: "pointExpirationDays",
      message: "Must be a whole number of at least 1",
    });
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
}

export const gamificationConfigService = new GamificationConfigService();
