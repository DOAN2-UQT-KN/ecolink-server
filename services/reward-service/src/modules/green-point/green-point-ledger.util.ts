import { Prisma } from "@prisma/client";

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

  return "credited";
}
