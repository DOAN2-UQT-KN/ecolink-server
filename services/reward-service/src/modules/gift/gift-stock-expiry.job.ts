import type { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../../config/prisma.client";

const INTERVAL_MS = Number(process.env.GIFT_STOCK_EXPIRY_INTERVAL_MS ?? 24 * 60 * 60 * 1000);

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Writes off what is left in every expired batch: an EXPIRED movement and remaining = 0, one short
 * transaction per batch. The `remaining = R` guard keeps a re-run (or a racing write) from writing twice;
 * a batch that fails is logged and retried next run. The cache is fixed afterwards by reconcileStockCache.
 */
export async function expireDueBatches(
  now: Date = new Date(),
  batchSize = 200,
  db: PrismaClient = prisma,
): Promise<{ expired: number; failed: number }> {
  let expired = 0;
  let failed = 0;
  let cursor: { expiresAt: Date; id: string } | null = null;

  for (;;) {
    const after: Prisma.GiftStockBatchWhereInput[] = cursor
      ? [
          {
            OR: [
              { expiresAt: { gt: cursor.expiresAt } },
              { expiresAt: cursor.expiresAt, id: { gt: cursor.id } },
            ],
          },
        ]
      : [];
    const batches = await db.giftStockBatch.findMany({
      where: { remaining: { gt: 0 }, expiresAt: { lte: now }, AND: after },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: batchSize,
    });
    if (batches.length === 0) break;

    for (const batch of batches) {
      try {
        const written = await db.$transaction(async (tx) => {
          const { count } = await tx.giftStockBatch.updateMany({
            where: { id: batch.id, remaining: batch.remaining },
            data: { remaining: 0 },
          });
          if (count === 0) return false;
          await tx.giftStockMovement.create({
            data: {
              giftId: batch.giftId,
              batchId: batch.id,
              type: "EXPIRED",
              quantity: -batch.remaining,
            },
          });
          return true;
        });
        if (written) expired++;
      } catch (error) {
        failed++;
        console.error(`[GiftStockExpiry] batch ${batch.id} not expired`, error);
      }
    }
    const last = batches[batches.length - 1];
    cursor = { expiresAt: last.expiresAt!, id: last.id };
  }
  return { expired, failed };
}

/** Sets gifts.stock_remaining to the live batches' remaining where they differ (spec 015 FR-023). */
export async function reconcileStockCache(db: PrismaClient = prisma, now: Date = new Date()): Promise<number> {
  return db.$executeRaw`
    UPDATE gifts g
    SET stock_remaining = live.total
    FROM (
      SELECT g2.id, COALESCE(SUM(b.remaining), 0)::int AS total
      FROM gifts g2
      LEFT JOIN gift_stock_batches b
        ON b.gift_id = g2.id AND b.remaining > 0 AND (b.expires_at IS NULL OR b.expires_at > ${now})
      GROUP BY g2.id
    ) live
    WHERE live.id = g.id AND g.stock_remaining <> live.total`;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const { expired, failed } = await expireDueBatches();
    const fixed = await reconcileStockCache();
    if (expired + failed + fixed > 0) {
      console.log(`[GiftStockExpiry] ${expired} batch(es) expired, ${failed} failed, ${fixed} cache(s) fixed`);
    }
  } catch (error) {
    console.error("[GiftStockExpiry] sweep failed", error);
  } finally {
    running = false;
  }
}

/** Daily sweep; redemptions already skip expired batches, so this keeps history and cache in step. */
export function startGiftStockExpiryJob(): void {
  if (process.env.GIFT_STOCK_EXPIRY_ENABLED === "false") {
    console.log("[GiftStockExpiry] disabled via GIFT_STOCK_EXPIRY_ENABLED=false");
    return;
  }
  if (timer) return;
  void tick();
  timer = setInterval(() => void tick(), INTERVAL_MS);
}

export function stopGiftStockExpiryJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
