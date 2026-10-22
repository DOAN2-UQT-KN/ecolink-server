import type { Prisma, PrismaClient } from "@prisma/client";
import { HTTP_STATUS, HttpError } from "../../constants/http-status";
import { EARNING_TRANSACTION_TYPES } from "./green-point-transaction.constants";

type Db = Prisma.TransactionClient | PrismaClient;

const EXPIRING_SOON_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Lots that still count: points left and not yet expired (a lot at its expiry instant is expired). */
const liveLots = (userId: string, now: Date): Prisma.GreenPointLotWhereInput => ({
  userId,
  remaining: { gt: 0 },
  expiresAt: { gt: now },
});

export async function getBalance(db: Db, userId: string, now: Date = new Date()): Promise<number> {
  const agg = await db.greenPointLot.aggregate({ where: liveLots(userId, now), _sum: { remaining: true } });
  return agg._sum.remaining ?? 0;
}

/** Points in live lots that expire within the next 7 days, and the earliest of those dates. */
export async function getExpiringSoon(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<{ amount: number; earliestAt: Date | null }> {
  const agg = await db.greenPointLot.aggregate({
    where: {
      ...liveLots(userId, now),
      expiresAt: { gt: now, lte: new Date(now.getTime() + EXPIRING_SOON_DAYS * DAY_MS) },
    },
    _sum: { remaining: true },
    _min: { expiresAt: true },
  });
  return { amount: agg._sum.remaining ?? 0, earliestAt: agg._min.expiresAt ?? null };
}

/** Sum of earnings only: refunds, expiry and adjustments never change it. */
export async function getEarnedTotal(db: Db, userId: string): Promise<number> {
  const agg = await db.greenPointTransaction.aggregate({
    where: { userId, deletedAt: null, type: { in: EARNING_TRANSACTION_TYPES } },
    _sum: { points: true },
  });
  return agg._sum.points ?? 0;
}

const insufficient = () =>
  new HttpError(HTTP_STATUS.UNPROCESSABLE_ENTITY.withMessage("Insufficient green points"));

/**
 * Takes `amount` from live lots, earliest expiry first, and records each take for the redemption.
 * Each decrement is conditional, so a lot never goes negative even if another request got there first.
 */
export async function spendLotsFifo(
  tx: Prisma.TransactionClient,
  userId: string,
  redemptionId: string,
  amount: number,
  now: Date = new Date(),
): Promise<void> {
  const lots = await tx.greenPointLot.findMany({
    where: liveLots(userId, now),
    orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }],
  });
  let left = amount;
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(lot.remaining, left);
    const { count } = await tx.greenPointLot.updateMany({
      where: { id: lot.id, remaining: { gte: take } },
      data: { remaining: { decrement: take } },
    });
    if (count === 0) throw insufficient();
    await tx.greenPointLotSpend.create({ data: { redemptionId, lotId: lot.id, amount: take } });
    left -= take;
  }
  if (left > 0) throw insufficient();
}

export type LotTake = { lotId: string; amount: number };

/** Splits a redemption's takes into lots still live (give back) and lots already expired (expire at once). */
export function planRefund(
  spends: LotTake[],
  expiresAtByLot: Map<string, Date>,
  now: Date,
): { restore: LotTake[]; expire: LotTake[] } {
  const restore: LotTake[] = [];
  const expire: LotTake[] = [];
  for (const s of spends) {
    const expiresAt = expiresAtByLot.get(s.lotId);
    (expiresAt && expiresAt > now ? restore : expire).push(s);
  }
  return { restore, expire };
}
