import { Gift, GiftRedemption, GiftRedemptionStatus, Media, Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import prisma from "../../config/prisma.client";
import { HTTP_STATUS, HttpError } from "../../constants/http-status";
import { fetchUsersByIds, getUserProfile } from "../../utils/identity-user.client";
import {
  GreenPointResourceType,
  GreenPointTransactionType,
  IdempotencyKey,
} from "../green-point/green-point-transaction.constants";
import {
  insertLedgerOnce,
  loadPointExpirationDays,
  lotExpiresAt,
} from "../green-point/green-point-ledger.util";
import { getBalance, planRefund, spendLotsFifo } from "../green-point/green-point-lot.util";
import {
  EXPIRING_SOON_DAYS,
  loadLiveBatchesForGifts,
  returnToBatch,
  takeOneFromBatches,
} from "./gift-stock.util";
import { liveLogoUrl } from "./gift-source.service";
import {
  AdminGiftRedemptionListItemResponse,
  CreateGiftBody,
  GiftRedemptionListItemResponse,
  GiftRedemptionGiftSnapshot,
  GiftRedemptionResponse,
  GiftResponse,
  RedeemGiftBody,
  toGiftRedemptionResponse,
  toGiftResponse,
  UpdateGiftBody,
} from "./gift.dto";
import { backgroundJobDispatcher } from "../../queue/green-point-queue.bootstrap";
import {
  TRANSLATE_TEXT_JOB_TYPE,
  TranslationFieldTarget,
  TranslationResourceType,
} from "../translation/translation.types";

/**
 * Best-effort enqueue of a TRANSLATE_TEXT job. Failure is logged but does NOT
 * propagate so request handlers stay fast and do not roll back the primary
 * write when SQS is unavailable.
 */
function enqueueGiftTranslationJob(
  resourceId: string,
  translations: TranslationFieldTarget[],
): void {
  const cleaned = translations.filter(
    (t) => t.sourceText.trim().length > 0 && (t.viField || t.enField),
  );
  if (cleaned.length === 0) {
    return;
  }
  backgroundJobDispatcher
    .enqueue(TRANSLATE_TEXT_JOB_TYPE, {
      resourceType: TranslationResourceType.GIFT,
      resourceId,
      translations: cleaned,
    })
    .catch((err: Error) => {
      console.error(
        "[reward-service] Failed to enqueue gift translation job:",
        err.message,
      );
    });
}

export type ListGiftsParams = {
  page: number;
  limit: number;
  search?: string;
  inStockOnly?: boolean;
  /** Honored only when `isAdmin` is true. */
  isActive?: boolean;
  greenPointsMin?: number;
  greenPointsMax?: number;
  isAdmin: boolean;
  sortBy?: "createdAt" | "name" | "greenPoints";
  sortOrder?: "asc" | "desc";
};

export type ListGiftRedemptionsParams = {
  page: number;
  limit: number;
  status?: GiftRedemptionStatus;
  sourceId?: string;
  sortBy?: "createdAt" | "greenPointsSpent" | "statusUpdatedAt";
  sortOrder?: "asc" | "desc";
};

const REDEMPTION_STATUS_TRANSITIONS: Record<
  GiftRedemptionStatus,
  GiftRedemptionStatus[]
> = {
  PROCESSING: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED", "CANCELLED"],
  DELIVERED: [],
  CANCELLED: [],
};

type GiftRedemptionWithGift = GiftRedemption & { gift: Gift | null };

function toGiftSnapshot(gift: Gift | null): GiftRedemptionGiftSnapshot | null {
  if (!gift) {
    return null;
  }
  return {
    id: gift.id,
    name: gift.name,
    nameVi: (gift as any).nameVi ?? gift.name,
    nameEn: (gift as any).nameEn,
    description: gift.description,
    descriptionVi: (gift as any).descriptionVi ?? gift.description,
    descriptionEn: (gift as any).descriptionEn,
    mediaId: gift.mediaId,
    greenPoints: gift.greenPoints,
  };
}

function toGiftRedemptionListItem(
  r: GiftRedemptionWithGift,
): GiftRedemptionListItemResponse {
  return {
    id: r.id,
    giftId: r.giftId,
    greenPointsSpent: r.greenPointsSpent,
    phoneNumber: r.phoneNumber,
    pickupLocation: r.pickupLocation,
    status: r.status,
    statusUpdatedAt: r.statusUpdatedAt.toISOString(),
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    batchId: r.batchId,
    gift: toGiftSnapshot(r.gift),
  };
}

export class GiftService {
  private async mapGiftsWithMediaByMediaId(
    rows: Gift[],
    isAdmin = false,
  ): Promise<GiftResponse[]> {
    const mediaIds = rows
      .map((row) => row.mediaId)
      .filter((id): id is string => Boolean(id));

    const mediaRows =
      mediaIds.length > 0
        ? await prisma.media.findMany({
            where: {
              id: { in: mediaIds },
              deletedAt: null,
            },
          })
        : [];

    const mediaById = new Map<string, Media>(
      mediaRows.map((media) => [media.id, media]),
    );

    // Stock, sponsors and the admin expiry hint all come from the live batches (spec 015 R2, R9).
    const now = new Date();
    const soon = now.getTime() + EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000;
    const batches = await loadLiveBatchesForGifts(prisma, rows.map((r) => r.id), now);

    return rows.map((row) => {
      const base = toGiftResponse({
        ...row,
        media: row.mediaId ? (mediaById.get(row.mediaId) ?? null) : null,
      });
      const own = batches.filter((b) => b.giftId === row.id);
      const sponsors = new Map<string, GiftResponse["sponsors"][number]>();
      for (const b of own) {
        if (b.source.showOnGift && !sponsors.has(b.source.id)) {
          sponsors.set(b.source.id, { id: b.source.id, name: b.source.name, logoUrl: liveLogoUrl(b.source.logo) });
        }
      }
      const expiring = own.filter((b) => b.expiresAt && b.expiresAt.getTime() <= soon);
      return {
        ...base,
        name: null,
        description: null,
        stockRemaining: own.reduce((sum, b) => sum + b.remaining, 0),
        sponsors: [...sponsors.values()],
        expiringSoon:
          isAdmin && expiring.length > 0
            ? {
                quantity: expiring.reduce((sum, b) => sum + b.remaining, 0),
                earliestAt: new Date(Math.min(...expiring.map((b) => b.expiresAt!.getTime()))).toISOString(),
              }
            : null,
      };
    });
  }

  async listGifts(params: ListGiftsParams): Promise<{
    gifts: GiftResponse[];
    total: number;
  }> {
    const andParts: Prisma.GiftWhereInput[] = [{ deletedAt: null }];

    if (!params.isAdmin) {
      andParts.push({ isActive: true });
    } else if (params.isActive !== undefined) {
      andParts.push({ isActive: params.isActive });
    }

    const q = params.search?.trim();
    if (q) {
      andParts.push({
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { nameVi: { contains: q, mode: "insensitive" } } as any,
          { nameEn: { contains: q, mode: "insensitive" } } as any,
        ],
      });
    }

    if (params.inStockOnly) {
      andParts.push({
        stockRemaining: { gt: 0 },
      });
    }

    if (params.greenPointsMin !== undefined) {
      andParts.push({ greenPoints: { gte: params.greenPointsMin } });
    }
    if (params.greenPointsMax !== undefined) {
      andParts.push({ greenPoints: { lte: params.greenPointsMax } });
    }

    const where: Prisma.GiftWhereInput = { AND: andParts };
    const skip = (params.page - 1) * params.limit;

    let orderBy: Prisma.GiftOrderByWithRelationInput = { createdAt: "desc" };
    if (params.sortBy) {
      const order = params.sortOrder === "asc" ? "asc" : "desc";
      orderBy = { [params.sortBy]: order };
    }

    const [rows, total] = await Promise.all([
      prisma.gift.findMany({
        where,
        orderBy,
        skip,
        take: params.limit,
      }),
      prisma.gift.count({ where }),
    ]);

    const gifts = await this.mapGiftsWithMediaByMediaId(rows, params.isAdmin);
    return { gifts, total };
  }

  async getGiftById(id: string, isAdmin = false): Promise<GiftResponse | null> {
    const row = await prisma.gift.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) {
      return null;
    }

    const [gift] = await this.mapGiftsWithMediaByMediaId([row], isAdmin);
    return gift ?? null;
  }

  async getGreenPointBalance(userId: string): Promise<number> {
    const row = await prisma.userGreenPointBalance.findUnique({
      where: { userId },
    });
    return row?.balance ?? 0;
  }

  async listRedemptionsForUser(
    userId: string,
    page: number,
    limit: number,
    sortBy: "createdAt" | "greenPointsSpent" | "statusUpdatedAt" = "createdAt",
    sortOrder: "asc" | "desc" = "desc",
  ): Promise<{ redemptions: GiftRedemptionListItemResponse[]; total: number }> {
    const skip = (page - 1) * limit;
    const where = { userId };

    const [rows, total] = await Promise.all([
      prisma.giftRedemption.findMany({
        where,
        orderBy: { [sortBy]: sortOrder },
        skip,
        take: limit,
        include: { gift: true },
      }),
      prisma.giftRedemption.count({ where }),
    ]);

    const redemptions = rows.map((r) => toGiftRedemptionListItem(r));

    return { redemptions, total };
  }

  async listRedemptionsForAdmin(
    params: ListGiftRedemptionsParams,
  ): Promise<{ redemptions: AdminGiftRedemptionListItemResponse[]; total: number }> {
    const skip = (params.page - 1) * params.limit;
    const where: Prisma.GiftRedemptionWhereInput = {
      ...(params.status ? { status: params.status } : {}),
      ...(params.sourceId ? { batch: { sourceId: params.sourceId } } : {}),
    };
    const sortBy = params.sortBy ?? "createdAt";
    const sortOrder = params.sortOrder ?? "desc";

    const [rows, total] = await Promise.all([
      prisma.giftRedemption.findMany({
        where,
        orderBy: { [sortBy]: sortOrder },
        skip,
        take: params.limit,
        include: { gift: true, batch: { select: { source: { select: { id: true, name: true } } } } },
      }),
      prisma.giftRedemption.count({ where }),
    ]);

    const profileMap = await fetchUsersByIds(rows.map((r) => r.userId));
    const redemptions: AdminGiftRedemptionListItemResponse[] = rows.map((r) => {
      const profile = getUserProfile(profileMap, r.userId);
      return {
        ...toGiftRedemptionListItem(r),
        userId: r.userId,
        user: profile
          ? {
              id: profile.id,
              name: profile.name,
              avatar: profile.avatar,
            }
          : null,
        source: r.batch ? { id: r.batch.source.id, name: r.batch.source.name } : null,
      };
    });

    return { redemptions, total };
  }

  async create(body: CreateGiftBody): Promise<GiftResponse> {
    const userNameVi = body.nameVi?.trim() || "";
    const userNameEn = body.nameEn?.trim() || "";
    const userDescriptionVi = body.descriptionVi?.trim() || "";
    const userDescriptionEn = body.descriptionEn?.trim() || "";

    const sourceName = userNameVi || userNameEn || body.name.trim();
    const sourceDescription =
      userDescriptionVi || userDescriptionEn || body.description.trim();

    const row = await prisma.$transaction(async (tx) => {
      let mediaId: string | null = null;
      if (body.imageUrl?.trim()) {
        const media = await tx.media.create({
          data: {
            id: randomUUID(),
            url: body.imageUrl.trim(),
            type: "GIFT",
          },
        });
        mediaId = media.id;
      }

      return tx.gift.create({
        data: {
          name: body.name.trim(),
          // Translations are filled asynchronously; until the worker runs we
          // store the source text so the row never has empty placeholders.
          nameVi: userNameVi || sourceName,
          nameEn: userNameEn || sourceName,
          mediaId,
          description: body.description.trim(),
          descriptionVi: userDescriptionVi || sourceDescription,
          descriptionEn: userDescriptionEn || sourceDescription,
          greenPoints: body.greenPoints,
          isActive: body.isActive ?? true,
        } as any,
      });
    });

    const translations: TranslationFieldTarget[] = [];
    if (sourceName && (!userNameVi || !userNameEn)) {
      translations.push({
        sourceText: sourceName,
        viField: userNameVi ? undefined : "nameVi",
        enField: userNameEn ? undefined : "nameEn",
      });
    }
    if (sourceDescription && (!userDescriptionVi || !userDescriptionEn)) {
      translations.push({
        sourceText: sourceDescription,
        viField: userDescriptionVi ? undefined : "descriptionVi",
        enField: userDescriptionEn ? undefined : "descriptionEn",
      });
    }
    enqueueGiftTranslationJob(row.id, translations);

    const [gift] = await this.mapGiftsWithMediaByMediaId([row]);
    return gift;
  }

  async updateById(
    id: string,
    body: UpdateGiftBody,
    _authorization?: string,
  ): Promise<GiftResponse | null> {
    const existing = await prisma.gift.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) {
      return null;
    }

    const userNameVi = body.nameVi?.trim() || "";
    const userNameEn = body.nameEn?.trim() || "";
    const userDescriptionVi = body.descriptionVi?.trim() || "";
    const userDescriptionEn = body.descriptionEn?.trim() || "";

    const sourceName =
      userNameVi || userNameEn || body.name?.trim() || "";
    const sourceDescription =
      userDescriptionVi ||
      userDescriptionEn ||
      body.description?.trim() ||
      "";
    // Pre-fill any missing language with the source text so the row reads back
    // sensibly until the translation worker overwrites it.
    if (sourceName) {
      if (body.nameVi === undefined) body.nameVi = sourceName;
      if (body.nameEn === undefined) body.nameEn = sourceName;
    }
    if (sourceDescription) {
      if (body.descriptionVi === undefined) body.descriptionVi = sourceDescription;
      if (body.descriptionEn === undefined) body.descriptionEn = sourceDescription;
    }

    const data: Prisma.GiftUpdateInput = {
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.nameVi !== undefined
        ? ({ nameVi: body.nameVi.trim() } as any)
        : {}),
      ...(body.nameEn !== undefined
        ? ({ nameEn: body.nameEn.trim() } as any)
        : {}),
      ...(body.description !== undefined
        ? { description: body.description.trim() }
        : {}),
      ...(body.descriptionVi !== undefined
        ? ({ descriptionVi: body.descriptionVi.trim() } as any)
        : {}),
      ...(body.descriptionEn !== undefined
        ? ({ descriptionEn: body.descriptionEn.trim() } as any)
        : {}),
      ...(body.greenPoints !== undefined
        ? { greenPoints: body.greenPoints }
        : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
    };

    if (Object.keys(data).length === 0 && body.imageUrl === undefined) {
      const unchanged = await prisma.gift.findFirst({
        where: { id: existing.id },
      });
      if (!unchanged) {
        return null;
      }
      const [gift] = await this.mapGiftsWithMediaByMediaId([unchanged]);
      return gift ?? null;
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (body.imageUrl !== undefined) {
        if (body.imageUrl.trim()) {
          const media = await tx.media.create({
            data: {
              id: randomUUID(),
              url: body.imageUrl.trim(),
              type: "GIFT",
            },
          });
          data.media = { connect: { id: media.id } };
        } else {
          data.media = { disconnect: true };
        }
      }

      return tx.gift.update({
        where: { id },
        data,
      });
    });

    const translations: TranslationFieldTarget[] = [];
    if (sourceName && (!userNameVi || !userNameEn)) {
      translations.push({
        sourceText: sourceName,
        viField: userNameVi ? undefined : "nameVi",
        enField: userNameEn ? undefined : "nameEn",
      });
    }
    if (sourceDescription && (!userDescriptionVi || !userDescriptionEn)) {
      translations.push({
        sourceText: sourceDescription,
        viField: userDescriptionVi ? undefined : "descriptionVi",
        enField: userDescriptionEn ? undefined : "descriptionEn",
      });
    }
    enqueueGiftTranslationJob(updated.id, translations);

    const [gift] = await this.mapGiftsWithMediaByMediaId([updated]);
    return gift;
  }

  async redeem(
    userId: string,
    giftId: string,
    body: RedeemGiftBody,
  ): Promise<GiftRedemptionResponse> {
    const phoneNumber = body.phoneNumber.trim();
    const pickupLocation = body.pickupLocation.trim();

    try {
      return await prisma.$transaction(
        async (tx) => {
          const gift = await tx.gift.findFirst({
            where: { id: giftId, deletedAt: null, isActive: true },
          });
          if (!gift) {
            throw new HttpError(
              HTTP_STATUS.NOT_FOUND.withMessage("Gift not found"),
            );
          }

          // Listed price for everyone (spec 014 FR-043: no badge discount).
          const price = gift.greenPoints;
          const now = new Date();
          if (price > 0 && (await getBalance(tx, userId, now)) < price) {
            throw new HttpError(
              HTTP_STATUS.UNPROCESSABLE_ENTITY.withMessage("Insufficient green points"),
            );
          }

          const created = await tx.giftRedemption.create({
            data: {
              userId,
              giftId: gift.id,
              greenPointsSpent: price,
              phoneNumber,
              pickupLocation,
              status: "PROCESSING",
              statusUpdatedAt: now,
            },
          });
          // One item from a live batch (spec 015 R3); out of stock rolls the order back.
          const batchId = await takeOneFromBatches(tx, gift.id, created.id, userId, now);
          const redemption = await tx.giftRedemption.update({
            where: { id: created.id },
            data: { batchId },
          });

          if (price > 0) {
            await spendLotsFifo(tx, userId, redemption.id, price, now);
            await insertLedgerOnce(tx, {
              userId,
              points: -price,
              type: GreenPointTransactionType.GIFT_REDEEM,
              resourceId: redemption.id,
              resourceType: GreenPointResourceType.GIFT_REDEMPTION,
              idempotencyKey: IdempotencyKey.giftRedeem(redemption.id),
              metadata: { giftId: gift.id, listPrice: price },
            });
          }

          return toGiftRedemptionResponse(redemption);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      // Serialization conflict with a concurrent redemption of the same user.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        throw new HttpError(HTTP_STATUS.CONFLICT.withMessage("Please retry"));
      }
      throw error;
    }
  }

  async updateRedemptionStatus(
    id: string,
    nextStatus: GiftRedemptionStatus,
    adminId: string | null = null,
  ): Promise<GiftRedemptionResponse | null> {
    return prisma.$transaction(
      async (tx) => {
        const redemption = await tx.giftRedemption.findUnique({ where: { id } });
        if (!redemption) {
          return null;
        }

        if (redemption.status === nextStatus) {
          return toGiftRedemptionResponse(redemption);
        }

        const allowed = REDEMPTION_STATUS_TRANSITIONS[redemption.status];
        if (!allowed.includes(nextStatus)) {
          throw new HttpError(
            HTTP_STATUS.UNPROCESSABLE_ENTITY.withMessage(
              `Cannot change redemption status from ${redemption.status} to ${nextStatus}`,
            ),
          );
        }

        const now = new Date();
        const updated = await tx.giftRedemption.update({
          where: { id },
          data: {
            status: nextStatus,
            statusUpdatedAt: now,
            cancelledAt: nextStatus === "CANCELLED" ? now : null,
          },
        });

        if (nextStatus === "CANCELLED" && redemption.greenPointsSpent > 0) {
          await refundRedemptionPoints(tx, redemption, now);
        }
        // Only an order still being prepared returns its item; shipped ones are decided in step 5-6.
        if (nextStatus === "CANCELLED" && redemption.status === "PROCESSING") {
          await returnToBatch(tx, redemption, adminId, now);
        }

        return toGiftRedemptionResponse(updated);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}

/**
 * Gives a cancelled redemption's points back, once (spec 014 FR-042): to the same lots it took from,
 * keeping their expiry; the share of lots already expired is written off at once (FR-042b). A
 * redemption from before lots were tracked gets a new lot instead (FR-042a).
 */
async function refundRedemptionPoints(
  tx: Prisma.TransactionClient,
  redemption: GiftRedemption,
  now: Date,
): Promise<void> {
  const refundId = await insertLedgerOnce(tx, {
    userId: redemption.userId,
    points: redemption.greenPointsSpent,
    type: GreenPointTransactionType.GIFT_REDEEM_REFUND,
    resourceId: redemption.id,
    resourceType: GreenPointResourceType.GIFT_REDEMPTION,
    idempotencyKey: IdempotencyKey.giftRedeemRefund(redemption.id),
    metadata: { giftId: redemption.giftId, redemptionId: redemption.id },
  });
  if (!refundId) return;

  const spends = await tx.greenPointLotSpend.findMany({
    where: { redemptionId: redemption.id },
    include: { lot: { select: { expiresAt: true } } },
  });
  if (spends.length === 0) {
    const expirationDays = await loadPointExpirationDays(tx);
    await tx.greenPointLot.create({
      data: {
        userId: redemption.userId,
        transactionId: refundId,
        amount: redemption.greenPointsSpent,
        remaining: redemption.greenPointsSpent,
        createdAt: now,
        expiresAt: lotExpiresAt(now, expirationDays),
      },
    });
    return;
  }

  const { restore, expire } = planRefund(
    spends,
    new Map(spends.map((sp) => [sp.lotId, sp.lot.expiresAt])),
    now,
  );
  for (const r of restore) {
    await tx.greenPointLot.update({
      where: { id: r.lotId },
      data: { remaining: { increment: r.amount } },
    });
  }
  for (const e of expire) {
    await insertLedgerOnce(tx, {
      userId: redemption.userId,
      points: -e.amount,
      type: GreenPointTransactionType.EXPIRE,
      resourceId: e.lotId,
      resourceType: GreenPointResourceType.GREEN_POINT_LOT,
      idempotencyKey: IdempotencyKey.expireOnRefund(e.lotId, redemption.id),
      metadata: { lotId: e.lotId, redemptionId: redemption.id },
    });
  }
}

export const giftService = new GiftService();
