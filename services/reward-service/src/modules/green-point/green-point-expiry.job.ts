import type { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../../config/prisma.client";
import { insertLedgerOnce } from "./green-point-ledger.util";
import {
  GreenPointResourceType,
  GreenPointTransactionType,
  IdempotencyKey,
} from "./green-point-transaction.constants";

const INTERVAL_MS = Number(process.env.GREEN_POINT_EXPIRY_INTERVAL_MS ?? 60 * 60 * 1000);

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Writes an EXPIRE ledger row for every expired lot with points left and empties the lot, one short
 * transaction per lot. A lot that fails (e.g. a redemption took from it meanwhile) is logged and left
 * for the next run; the cursor keeps it from being retried in this run.
 */
export async function expireDueLots(
  now: Date = new Date(),
  batchSize = 200,
  db: PrismaClient = prisma,
): Promise<{ expired: number; failed: number }> {
  let expired = 0;
  let failed = 0;
  let cursor: { expiresAt: Date; id: string } | null = null;

  for (;;) {
    const after: Prisma.GreenPointLotWhereInput[] = cursor
      ? [
          {
            OR: [
              { expiresAt: { gt: cursor.expiresAt } },
              { expiresAt: cursor.expiresAt, id: { gt: cursor.id } },
            ],
          },
        ]
      : [];
    const lots = await db.greenPointLot.findMany({
      where: { remaining: { gt: 0 }, expiresAt: { lte: now }, AND: after },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: batchSize,
    });
    if (lots.length === 0) break;

    for (const lot of lots) {
      try {
        const written = await db.$transaction(async (tx) => {
          const id = await insertLedgerOnce(tx, {
            userId: lot.userId,
            points: -lot.remaining,
            type: GreenPointTransactionType.EXPIRE,
            resourceId: lot.id,
            resourceType: GreenPointResourceType.GREEN_POINT_LOT,
            idempotencyKey: IdempotencyKey.expire(lot.id),
            metadata: { lotId: lot.id },
          });
          if (!id) return false;
          const { count } = await tx.greenPointLot.updateMany({
            where: { id: lot.id, remaining: lot.remaining },
            data: { remaining: 0 },
          });
          if (count === 0) throw new Error(`lot ${lot.id} changed while expiring`);
          return true;
        });
        if (written) expired++;
      } catch (error) {
        failed++;
        console.error(`[GreenPointExpiry] lot ${lot.id} not expired`, error);
      }
    }
    const last = lots[lots.length - 1];
    cursor = { expiresAt: last.expiresAt, id: last.id };
  }
  return { expired, failed };
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const { expired, failed } = await expireDueLots();
    if (expired + failed > 0) {
      console.log(`[GreenPointExpiry] ${expired} lot(s) expired, ${failed} failed`);
    }
  } catch (error) {
    console.error("[GreenPointExpiry] sweep failed", error);
  } finally {
    running = false;
  }
}

/** Hourly sweep; balances already ignore expired lots, so this only keeps the history complete. */
export function startGreenPointExpiryJob(): void {
  if (process.env.GREEN_POINT_EXPIRY_ENABLED === "false") {
    console.log("[GreenPointExpiry] disabled via GREEN_POINT_EXPIRY_ENABLED=false");
    return;
  }
  if (timer) return;
  void tick();
  timer = setInterval(() => void tick(), INTERVAL_MS);
}

export function stopGreenPointExpiryJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
