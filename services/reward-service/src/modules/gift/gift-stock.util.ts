import { randomUUID } from "crypto";
import type {
  GiftRedemption,
  GiftStockAdjustReason,
  GiftStockBatch,
  GiftStockMovementType,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { HTTP_STATUS, HttpError } from "../../constants/http-status";

type Db = Prisma.TransactionClient | PrismaClient;

const DAY_MS = 24 * 60 * 60 * 1000;
export const EXPIRING_SOON_DAYS = 7;

/** Batches that still count: items left and not expired (a batch at its expiry instant is expired). */
export const liveBatchWhere = (now: Date): Prisma.GiftStockBatchWhereInput => ({
  remaining: { gt: 0 },
  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
});

export const isLive = (batch: Pick<GiftStockBatch, "expiresAt">, now: Date): boolean =>
  batch.expiresAt === null || batch.expiresAt > now;

export type BatchState = "IN_STOCK" | "OUT_OF_STOCK" | "EXPIRING_SOON" | "EXPIRED";

export function batchState(
  batch: Pick<GiftStockBatch, "remaining" | "expiresAt">,
  now: Date,
): BatchState {
  if (!isLive(batch, now)) return "EXPIRED";
  if (batch.remaining === 0) return "OUT_OF_STOCK";
  if (batch.expiresAt && batch.expiresAt.getTime() <= now.getTime() + EXPIRING_SOON_DAYS * DAY_MS) {
    return "EXPIRING_SOON";
  }
  return "IN_STOCK";
}

export type StockBatchResponse = {
  id: string;
  giftId: string;
  quantity: number;
  remaining: number;
  unitValueVnd: number;
  receivedAt: string;
  expiresAt: string | null;
  reference: string;
  attachmentUrls: string[];
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  state: BatchState;
};

export function toStockBatchResponse(batch: GiftStockBatch, now: Date): StockBatchResponse {
  return {
    id: batch.id,
    giftId: batch.giftId,
    quantity: batch.quantity,
    remaining: batch.remaining,
    unitValueVnd: batch.unitValueVnd,
    receivedAt: batch.receivedAt.toISOString(),
    expiresAt: batch.expiresAt?.toISOString() ?? null,
    reference: batch.reference,
    attachmentUrls: batch.attachmentUrls,
    note: batch.note,
    createdBy: batch.createdBy,
    createdAt: batch.createdAt.toISOString(),
    state: batchState(batch, now),
  };
}

type MovementRow = {
  giftId: string;
  batchId: string;
  type: GiftStockMovementType;
  quantity: number;
  reason?: GiftStockAdjustReason | null;
  note?: string | null;
  redemptionId?: string | null;
  actorId?: string | null;
};

/**
 * Inserts the movement unless (redemption_id, type) exists; true when written. ON CONFLICT DO NOTHING
 * instead of catching P2002, which would abort the surrounding Postgres transaction (spec 014 R1).
 */
export async function insertMovementOnce(
  tx: Prisma.TransactionClient,
  row: MovementRow,
): Promise<boolean> {
  const { count } = await tx.giftStockMovement.createMany({
    data: [{ id: randomUUID(), ...row }],
    skipDuplicates: true,
  });
  return count === 1;
}

/** Keeps the `gifts.stock_remaining` cache in step with a live batch change (spec 015 R2). */
export async function bumpStockCache(
  tx: Prisma.TransactionClient,
  giftId: string,
  delta: number,
): Promise<void> {
  if (delta === 0) return;
  await tx.gift.update({ where: { id: giftId }, data: { stockRemaining: { increment: delta } } });
}

export type LiveBatchWithSource = GiftStockBatch & {
  source: {
    id: string;
    name: string;
    showOnGift: boolean;
    logo: { url: string; deletedAt: Date | null } | null;
  };
};

/** Live batches of the listed gifts with their source and logo, in one query. */
export async function loadLiveBatchesForGifts(
  db: Db,
  giftIds: string[],
  now: Date,
): Promise<LiveBatchWithSource[]> {
  if (giftIds.length === 0) return [];
  return db.giftStockBatch.findMany({
    where: { giftId: { in: giftIds }, ...liveBatchWhere(now) },
    include: {
      source: {
        select: {
          id: true,
          name: true,
          showOnGift: true,
          logo: { select: { url: true, deletedAt: true } },
        },
      },
    },
  });
}

const outOfStock = () =>
  new HttpError(HTTP_STATUS.UNPROCESSABLE_ENTITY.withMessage("Gift is out of stock"));

/**
 * Takes one item for a redemption: earliest expiry first, batches without expiry last, then earliest
 * received. The decrement is conditional, so a batch emptied by another request is skipped.
 */
export async function takeOneFromBatches(
  tx: Prisma.TransactionClient,
  giftId: string,
  redemptionId: string,
  userId: string,
  now: Date,
): Promise<string> {
  const batches = await tx.giftStockBatch.findMany({
    where: { giftId, ...liveBatchWhere(now) },
    orderBy: [{ expiresAt: { sort: "asc", nulls: "last" } }, { receivedAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  for (const { id } of batches) {
    const { count } = await tx.giftStockBatch.updateMany({
      where: { id, remaining: { gt: 0 } },
      data: { remaining: { decrement: 1 } },
    });
    if (count === 0) continue;
    await insertMovementOnce(tx, {
      giftId,
      batchId: id,
      type: "REDEEM_OUT",
      quantity: -1,
      redemptionId,
      actorId: userId,
    });
    await bumpStockCache(tx, giftId, -1);
    return id;
  }
  throw outOfStock();
}

/** Puts a cancelled redemption's item back into its batch, once (spec 015 R5). */
export async function returnToBatch(
  tx: Prisma.TransactionClient,
  redemption: Pick<GiftRedemption, "id" | "giftId" | "batchId">,
  actorId: string | null,
  now: Date,
): Promise<boolean> {
  if (!redemption.batchId) return false;
  const written = await insertMovementOnce(tx, {
    giftId: redemption.giftId,
    batchId: redemption.batchId,
    type: "CANCEL_RETURN",
    quantity: 1,
    redemptionId: redemption.id,
    actorId,
  });
  if (!written) return false;
  const batch = await tx.giftStockBatch.update({
    where: { id: redemption.batchId },
    data: { remaining: { increment: 1 } },
  });
  // An expired batch no longer counts; the expiry job writes this item off on its next run.
  if (isLive(batch, now)) await bumpStockCache(tx, redemption.giftId, 1);
  return true;
}

/** Writes `quantity` items off a batch with a reason; never below zero. */
export async function adjustBatch(
  tx: Prisma.TransactionClient,
  batchId: string,
  quantity: number,
  reason: GiftStockAdjustReason,
  note: string | null,
  actorId: string,
  now: Date,
) {
  const batch = await tx.giftStockBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Stock batch not found"));
  const { count } = await tx.giftStockBatch.updateMany({
    where: { id: batchId, remaining: { gte: quantity } },
    data: { remaining: { decrement: quantity } },
  });
  if (count === 0) {
    throw new HttpError(HTTP_STATUS.UNPROCESSABLE_ENTITY.withMessage("Not enough stock in batch"));
  }
  const movement = await tx.giftStockMovement.create({
    data: {
      giftId: batch.giftId,
      batchId,
      type: "ADJUST_OUT",
      quantity: -quantity,
      reason,
      note,
      actorId,
    },
  });
  if (isLive(batch, now)) await bumpStockCache(tx, batch.giftId, -quantity);
  const updated = await tx.giftStockBatch.findUniqueOrThrow({ where: { id: batchId } });
  return { batch: updated, movement };
}
