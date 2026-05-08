import { Gift, Media, Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import prisma from "../../config/prisma.client";
import { HTTP_STATUS, HttpError } from "../../constants/http-status";
import { badgeService } from "../gamification/badge.service";
import {
  getSpendableSpBalance,
  spendSpFifo,
} from "../gamification/sp-wallet.util";
import {
  GreenPointResourceType,
  GreenPointTransactionType,
} from "../green-point/green-point-transaction.constants";
import {
  CreateGiftBody,
  GiftRedemptionListItemResponse,
  GiftRedemptionResponse,
  GiftResponse,
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

export class GiftService {
  private async mapGiftsWithMediaByMediaId(
    rows: Gift[],
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

    return rows.map((row) => {
      const base = toGiftResponse({
        ...row,
        media: row.mediaId ? (mediaById.get(row.mediaId) ?? null) : null,
      });
      return {
        ...base,
        name: null,
        description: null,
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
        OR: [{ stockRemaining: null }, { stockRemaining: { gt: 0 } }],
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

    const gifts = await this.mapGiftsWithMediaByMediaId(rows);
    return { gifts, total };
  }

  async getGiftById(id: string): Promise<GiftResponse | null> {
    const row = await prisma.gift.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) {
      return null;
    }

    const [gift] = await this.mapGiftsWithMediaByMediaId([row]);
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
    sortBy: "createdAt" | "greenPointsSpent" = "createdAt",
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

    const redemptions: GiftRedemptionListItemResponse[] = rows.map((r) => ({
      id: r.id,
      giftId: r.giftId,
      greenPointsSpent: r.greenPointsSpent,
      createdAt: r.createdAt.toISOString(),
      gift: r.gift
        ? {
            id: r.gift.id,
            name: r.gift.name,
            nameVi: (r.gift as any).nameVi ?? r.gift.name,
            nameEn: (r.gift as any).nameEn,
            description: r.gift.description,
            descriptionVi: (r.gift as any).descriptionVi ?? r.gift.description,
            descriptionEn: (r.gift as any).descriptionEn,
            mediaId: r.gift.mediaId,
            greenPoints: r.gift.greenPoints,
          }
        : null,
    }));

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
          stockRemaining:
            body.stockRemaining === undefined ? null : body.stockRemaining,
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
      ...(body.stockRemaining !== undefined
        ? { stockRemaining: body.stockRemaining }
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
  ): Promise<GiftRedemptionResponse> {
    const discountBps = await badgeService.getBestStoreDiscountBps(userId);

    return prisma.$transaction(
      async (tx) => {
        const gift = await tx.gift.findFirst({
          where: { id: giftId, deletedAt: null, isActive: true },
        });
        if (!gift) {
          throw new HttpError(
            HTTP_STATUS.NOT_FOUND.withMessage("Gift not found"),
          );
        }

        if (gift.stockRemaining !== null) {
          const stock = await tx.gift.updateMany({
            where: { id: gift.id, stockRemaining: { gt: 0 } },
            data: { stockRemaining: { decrement: 1 } },
          });
          if (stock.count === 0) {
            throw new HttpError(
              HTTP_STATUS.UNPROCESSABLE_ENTITY.withMessage(
                "Gift is out of stock",
              ),
            );
          }
        }

        const listPrice = gift.greenPoints;
        const effectiveSp = Math.ceil(
          (listPrice * Math.max(0, 10_000 - discountBps)) / 10_000,
        );

        const now = new Date();
        if (effectiveSp > 0) {
          const spBal = await getSpendableSpBalance(tx, userId, now);
          if (spBal < effectiveSp) {
            throw new HttpError(
              HTTP_STATUS.UNPROCESSABLE_ENTITY.withMessage(
                "Insufficient spendable points (SP)",
              ),
            );
          }
        }

        const redemption = await tx.giftRedemption.create({
          data: {
            userId,
            giftId: gift.id,
            greenPointsSpent: effectiveSp,
          },
        });

        if (effectiveSp > 0) {
          await spendSpFifo(tx, userId, effectiveSp, now);
          await tx.userPointTransaction.create({
            data: {
              id: randomUUID(),
              userId,
              kind: "SP",
              amount: -effectiveSp,
              sourceType: "STORE",
              sourceId: redemption.id,
              seasonId: null,
              metadata: {
                giftId: gift.id,
                redemptionId: redemption.id,
                listPrice,
                discountBps,
                effectiveSp,
              } as Prisma.InputJsonValue,
              idempotencyKey: `gift_redeem_sp:${redemption.id}`,
            },
          });
        }

        if (effectiveSp > 0) {
          await tx.greenPointTransaction.create({
            data: {
              userId,
              type: GreenPointTransactionType.GIFT_REDEEM,
              resourceId: redemption.id,
              resourceType: GreenPointResourceType.GIFT_REDEMPTION,
              points: -effectiveSp,
            },
          });
        }

        return toGiftRedemptionResponse(redemption);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}

export const giftService = new GiftService();
