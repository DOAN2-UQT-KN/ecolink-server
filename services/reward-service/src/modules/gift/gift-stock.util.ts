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
 * Inserts the movement unless (redemption_id, batch_id, type) exists; true when written. ON CONFLICT DO NOTHING
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
const notEnoughStock = () =>
  new HttpError(HTTP_STATUS.UNPROCESSABLE_ENTITY.withMessage("Not enough stock"));

/** Items an order took from one batch; the order's REDEEM_OUT movement for that batch. */
export type BatchTake = { batchId: string; quantity: number };

/**
 * Takes `quantity` items for a redemption: earliest expiry first, batches without expiry last, then
 * earliest received, possibly across several batches (one warehouse, so this is bookkeeping only).
 * Each decrement is conditional; a batch drained by another request is re-read. Too few items throws,
 * and the caller's transaction rolls back whatever was taken (all or nothing, spec 018 FR-004).
 */
export async function takeFromBatches(
  tx: Prisma.TransactionClient,
  giftId: string,
  redemptionId: string,
  userId: string,
  quantity: number,
  now: Date,
): Promise<BatchTake[]> {
  const batches = await tx.giftStockBatch.findMany({
    where: { giftId, ...liveBatchWhere(now) },
    orderBy: [{ expiresAt: { sort: "asc", nulls: "last" } }, { receivedAt: "asc" }, { id: "asc" }],
    select: { id: true, remaining: true },
  });
  const taken: BatchTake[] = [];
  let need = quantity;
  for (const batch of batches) {
    let available = batch.remaining;
    while (need > 0 && available > 0) {
      const take = Math.min(need, available);
      const { count } = await tx.giftStockBatch.updateMany({
        where: { id: batch.id, remaining: { gte: take } },
        data: { remaining: { decrement: take } },
      });
      if (count === 1) {
        await insertMovementOnce(tx, {
          giftId,
          batchId: batch.id,
          type: "REDEEM_OUT",
          quantity: -take,
          redemptionId,
          actorId: userId,
        });
        taken.push({ batchId: batch.id, quantity: take });
        need -= take;
        break;
      }
      const fresh = await tx.giftStockBatch.findUnique({ where: { id: batch.id }, select: { remaining: true } });
      available = fresh?.remaining ?? 0;
    }
    if (need === 0) break;
  }
  if (need > 0) throw taken.length === 0 ? outOfStock() : notEnoughStock();
  await bumpStockCache(tx, giftId, -quantity);
  return taken;
}

/** What an order needs from its REDEEM_OUT movements to name the sources its items came from. */
export const REDEEM_SOURCES_INCLUDE = {
  where: { type: "REDEEM_OUT" },
  orderBy: { createdAt: "asc" },
  select: { quantity: true, batch: { select: { source: { select: { id: true, name: true } } } } },
} satisfies Prisma.GiftRedemption$stockMovementsArgs;

/** Items per source, in the order they were taken; empty for orders before spec 015. */
export function toRedemptionSources(
  movements: Array<{ quantity: number; batch: { source: { id: string; name: string } } }>,
): Array<{ id: string; name: string; quantity: number }> {
  const bySource = new Map<string, { id: string; name: string; quantity: number }>();
  for (const m of movements) {
    const { id, name } = m.batch.source;
    const row = bySource.get(id) ?? { id, name, quantity: 0 };
    row.quantity += Math.abs(m.quantity);
    bySource.set(id, row);
  }
  return [...bySource.values()];
}

/**
 * Puts a cancelled redemption's items back into the batches they came from, once per batch
 * (spec 015 R5, spec 018 R3). Returns how many items went back; 0 for orders before spec 015.
 */
export async function returnToBatches(
  tx: Prisma.TransactionClient,
  redemption: Pick<GiftRedemption, "id" | "giftId">,
  actorId: string | null,
  now: Date,
): Promise<number> {
  const outs = await tx.giftStockMovement.findMany({
    where: { redemptionId: redemption.id, type: "REDEEM_OUT" },
    select: { batchId: true, quantity: true },
  });
  let returned = 0;
  for (const out of outs) {
    const quantity = -out.quantity;
    const written = await insertMovementOnce(tx, {
      giftId: redemption.giftId,
      batchId: out.batchId,
      type: "CANCEL_RETURN",
      quantity,
      redemptionId: redemption.id,
      actorId,
    });
    if (!written) continue;
    const batch = await tx.giftStockBatch.update({
      where: { id: out.batchId },
      data: { remaining: { increment: quantity } },
    });
    // An expired batch no longer counts; the expiry job writes these items off on its next run.
    if (isLive(batch, now)) await bumpStockCache(tx, redemption.giftId, quantity);
    returned += quantity;
  }
  return returned;
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
