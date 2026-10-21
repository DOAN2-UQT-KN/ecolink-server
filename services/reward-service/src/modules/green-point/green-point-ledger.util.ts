import { Prisma } from "@prisma/client";
import { applyRankingPointCredit } from "../gamification/rp-credit.util";
import { applySpendablePointCredit } from "../gamification/sp-credit.util";
import type {
  GreenPointApplyResult,
  ResolvedCredit,
} from "./strategies/green-point-credit-strategy.types";

export type LedgerApplyOutcome = "credited" | "skipped";

/**
 * Single idempotent ledger row + balance bump (partial unique index on active rows).
 */
export async function applyGreenPointLedgerCredit(
  tx: Prisma.TransactionClient,
  params: {
    userId: string;
    points: number;
    transactionType: string;
    resourceId: string;
    resourceType: string;
    metadata?: Prisma.InputJsonValue;
  },
): Promise<LedgerApplyOutcome> {
  if (params.points <= 0) {
    return "skipped";
  }

  try {
    await tx.greenPointTransaction.create({
      data: {
        userId: params.userId,
        type: params.transactionType,
        resourceId: params.resourceId,
        resourceType: params.resourceType,
        points: params.points,
        metadata: params.metadata,
      },
    });
  } catch (e: unknown) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      return "skipped";
    }
    throw e;
  }

  await tx.userGreenPointBalance.upsert({
    where: { userId: params.userId },
    create: { userId: params.userId, balance: params.points },
    update: { balance: { increment: params.points } },
  });

  await applySpendablePointCredit(tx, params);
  await applyRankingPointCredit(tx, params);

  return "credited";
}

/** Applies each resolved credit; duplicates and zero amounts count as skipped. */
export async function applyResolvedCredits(
  tx: Prisma.TransactionClient,
  credits: ResolvedCredit[],
): Promise<GreenPointApplyResult> {
  let credited = 0;
  let skipped = 0;
  for (const credit of credits) {
    const outcome = await applyGreenPointLedgerCredit(tx, credit);
    if (outcome === "credited") credited++;
    else skipped++;
  }
  return { credited, skipped };
}

/** No active point rules: nothing to credit (spec 013 FR-033). Not an error, so no retry. */
export function warnNoPointRules(jobType: string, resourceId: string): GreenPointApplyResult {
  console.warn(`[green-point] no active point rules; ${jobType} for ${resourceId} not credited`);
  return { credited: 0, skipped: 0 };
}
