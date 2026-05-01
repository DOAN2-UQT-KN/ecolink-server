import type { Prisma } from "@prisma/client";

/**
 * Sum non-expired SP wallet `remaining` for a user.
 */
export async function getSpendableSpBalance(
  tx: Prisma.TransactionClient,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const agg = await tx.userSpWalletEntry.aggregate({
    where: {
      userId,
      remaining: { gt: 0 },
      expiresAt: { gte: now },
    },
    _sum: { remaining: true },
  });
  return agg._sum.remaining ?? 0;
}

/**
 * FIFO by earliest `expiresAt`, then `createdAt`. Throws if insufficient spendable SP.
 */
export async function spendSpFifo(
  tx: Prisma.TransactionClient,
  userId: string,
  amount: number,
  now: Date = new Date(),
): Promise<void> {
  if (amount <= 0) {
    return;
  }

  let remaining = amount;
  const rows = await tx.userSpWalletEntry.findMany({
    where: {
      userId,
      remaining: { gt: 0 },
      expiresAt: { gte: now },
    },
    orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }],
  });

  for (const row of rows) {
    if (remaining <= 0) {
      break;
    }
    const take = Math.min(row.remaining, remaining);
    await tx.userSpWalletEntry.update({
      where: { id: row.id },
      data: { remaining: row.remaining - take },
    });
    remaining -= take;
  }

  if (remaining > 0) {
    throw new Error("INSUFFICIENT_SP");
  }
}
