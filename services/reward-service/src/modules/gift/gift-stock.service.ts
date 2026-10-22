import type {
  GiftSource,
  GiftStockAdjustReason,
  GiftStockBatch,
  GiftStockMovementType,
  Prisma,
} from "@prisma/client";
import prisma from "../../config/prisma.client";
import { HTTP_STATUS, HttpError } from "../../constants/http-status";
import { fetchUsersByIds, getUserProfile } from "../../utils/identity-user.client";
import { adjustBatch, bumpStockCache, toStockBatchResponse, type StockBatchResponse } from "./gift-stock.util";

export type StockInBody = {
  sourceId: string;
  quantity: number;
  unitValueVnd: number;
  receivedAt: Date;
  expiresAt?: Date | null;
  reference: string;
  attachmentUrls?: string[];
  note?: string | null;
};

type BatchWithSource = GiftStockBatch & { source: Pick<GiftSource, "id" | "name" | "type" | "status"> };

export type GiftStockBatchResponse = StockBatchResponse & {
  source: { id: string; name: string; type: string; status: string };
};

const sourceSelect = { select: { id: true, name: true, type: true, status: true } } as const;

const withSource = (b: BatchWithSource, now: Date): GiftStockBatchResponse => ({
  ...toStockBatchResponse(b, now),
  source: { id: b.source.id, name: b.source.name, type: b.source.type, status: b.source.status },
});

const giftNotFound = () => new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Gift not found"));

async function liveGift(db: Prisma.TransactionClient | typeof prisma, giftId: string) {
  const gift = await db.gift.findFirst({ where: { id: giftId, deletedAt: null }, select: { id: true } });
  if (!gift) throw giftNotFound();
  return gift;
}

export class GiftStockService {
  /** Receives a batch: batch, STOCK_IN and cache in one transaction (spec 015 FR-012). */
  async stockIn(giftId: string, body: StockInBody, adminId: string | null) {
    return prisma.$transaction(async (tx) => {
      await liveGift(tx, giftId);
      const source = await tx.giftSource.findUnique({ where: { id: body.sourceId } });
      if (!source) throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Gift source not found"));
      if (source.status !== "ACTIVE") {
        throw new HttpError(HTTP_STATUS.UNPROCESSABLE_ENTITY.withMessage("Gift source is inactive"));
      }
      const now = new Date();
      const batch = await tx.giftStockBatch.create({
        data: {
          giftId,
          sourceId: source.id,
          quantity: body.quantity,
          remaining: body.quantity,
          unitValueVnd: body.unitValueVnd,
          receivedAt: body.receivedAt,
          expiresAt: body.expiresAt ?? null,
          reference: body.reference.trim(),
          attachmentUrls: body.attachmentUrls ?? [],
          note: body.note?.trim() || null,
          createdBy: adminId,
        },
        include: { source: sourceSelect },
      });
      await tx.giftStockMovement.create({
        data: { giftId, batchId: batch.id, type: "STOCK_IN", quantity: body.quantity, actorId: adminId },
      });
      // A batch received already expired never counts; the cache only follows live batches.
      if (!batch.expiresAt || batch.expiresAt > now) await bumpStockCache(tx, giftId, body.quantity);
      const gift = await tx.gift.findUniqueOrThrow({ where: { id: giftId }, select: { stockRemaining: true } });
      return { batch: withSource(batch, now), stockRemaining: gift.stockRemaining };
    });
  }

  /** Batches of a gift in the order redemptions take from them. */
  async listBatches(giftId: string, params: { page: number; limit: number; sourceId?: string }) {
    await liveGift(prisma, giftId);
    const where: Prisma.GiftStockBatchWhereInput = {
      giftId,
      ...(params.sourceId ? { sourceId: params.sourceId } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.giftStockBatch.findMany({
        where,
        include: { source: sourceSelect },
        orderBy: [{ expiresAt: { sort: "asc", nulls: "last" } }, { receivedAt: "asc" }, { id: "asc" }],
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.giftStockBatch.count({ where }),
    ]);
    const now = new Date();
    return { batches: rows.map((b) => withSource(b, now)), total };
  }

  async adjust(
    batchId: string,
    body: { quantity: number; reason: GiftStockAdjustReason; note?: string | null },
    adminId: string,
  ) {
    return prisma.$transaction(async (tx) => {
      const now = new Date();
      const { batch, movement } = await adjustBatch(
        tx,
        batchId,
        body.quantity,
        body.reason,
        body.note?.trim() || null,
        adminId,
        now,
      );
      const withSrc = await tx.giftStockBatch.findUniqueOrThrow({
        where: { id: batch.id },
        include: { source: sourceSelect },
      });
      const gift = await tx.gift.findUniqueOrThrow({
        where: { id: batch.giftId },
        select: { stockRemaining: true },
      });
      return {
        batch: withSource(withSrc, now),
        movement: {
          id: movement.id,
          giftId: movement.giftId,
          batchId: movement.batchId,
          type: movement.type,
          quantity: movement.quantity,
          reason: movement.reason,
          note: movement.note,
          redemptionId: movement.redemptionId,
          createdAt: movement.createdAt.toISOString(),
        },
        stockRemaining: gift.stockRemaining,
      };
    });
  }

  /** Stock history of a gift, newest first (spec 015 FR-048). */
  async listMovements(
    giftId: string,
    params: { page: number; limit: number; batchId?: string; type?: GiftStockMovementType },
  ) {
    await liveGift(prisma, giftId);
    const where: Prisma.GiftStockMovementWhereInput = {
      giftId,
      ...(params.batchId ? { batchId: params.batchId } : {}),
      ...(params.type ? { type: params.type } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.giftStockMovement.findMany({
        where,
        include: { batch: { select: { source: { select: { name: true } } } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.giftStockMovement.count({ where }),
    ]);
    const actorIds = rows.map((r) => r.actorId).filter((id): id is string => Boolean(id));
    const profiles = actorIds.length > 0 ? await fetchUsersByIds(actorIds) : null;
    const movements = rows.map((m) => {
      const profile = m.actorId && profiles ? getUserProfile(profiles, m.actorId) : null;
      return {
        id: m.id,
        giftId: m.giftId,
        batchId: m.batchId,
        sourceName: m.batch.source.name,
        type: m.type,
        quantity: m.quantity,
        reason: m.reason,
        note: m.note,
        redemptionId: m.redemptionId,
        actor: m.actorId ? { id: m.actorId, name: profile?.name ?? "" } : null,
        createdAt: m.createdAt.toISOString(),
      };
    });
    return { movements, total };
  }
}

export const giftStockService = new GiftStockService();
