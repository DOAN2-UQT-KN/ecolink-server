import { Gift, Media, Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import prisma from "../../config/prisma.client";
import { HTTP_STATUS, HttpError } from "../../constants/http-status";
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
import { translateText } from "../translation/translation.client";

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
    const sourceName =
      body.nameVi?.trim() || body.nameEn?.trim() || body.name.trim();
    const sourceDescription =
      body.descriptionVi?.trim() ||
      body.descriptionEn?.trim() ||
      body.description.trim();
    const [nameTr, descTr] = await Promise.all([
      translateText(sourceName, undefined),
      translateText(sourceDescription, undefined),
    ]);
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
          nameVi: body.nameVi?.trim() || nameTr.vi,
          nameEn: body.nameEn?.trim() || nameTr.en,
          mediaId,
          description: body.description.trim(),
          descriptionVi: body.descriptionVi?.trim() || descTr.vi,
          descriptionEn: body.descriptionEn?.trim() || descTr.en,
          greenPoints: body.greenPoints,
          stockRemaining:
            body.stockRemaining === undefined ? null : body.stockRemaining,
          isActive: body.isActive ?? true,
        } as any,
      });
    });
    const [gift] = await this.mapGiftsWithMediaByMediaId([row]);
    return gift;
  }

  async updateById(
    id: string,
    body: UpdateGiftBody,
    authorization?: string,
  ): Promise<GiftResponse | null> {
    const existing = await prisma.gift.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) {
      return null;
    }

    const sourceName =
      body.nameVi?.trim() || body.nameEn?.trim() || body.name?.trim() || "";
    const sourceDescription =
      body.descriptionVi?.trim() ||
      body.descriptionEn?.trim() ||
      body.description?.trim() ||
      "";
    if (sourceName) {
      const tr = await translateText(sourceName, authorization);
      if (body.nameVi === undefined) body.nameVi = tr.vi;
      if (body.nameEn === undefined) body.nameEn = tr.en;
    }
    if (sourceDescription) {
      const tr = await translateText(sourceDescription, authorization);
      if (body.descriptionVi === undefined) body.descriptionVi = tr.vi;
      if (body.descriptionEn === undefined) body.descriptionEn = tr.en;
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
    const [gift] = await this.mapGiftsWithMediaByMediaId([updated]);
    return gift;
  }

  async redeem(
    userId: string,
    giftId: string,
  ): Promise<GiftRedemptionResponse> {
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

        if (gift.greenPoints > 0) {
          const bal = await tx.userGreenPointBalance.updateMany({
            where: { userId, balance: { gte: gift.greenPoints } },
            data: { balance: { decrement: gift.greenPoints } },
          });
          if (bal.count === 0) {
            throw new HttpError(
              HTTP_STATUS.UNPROCESSABLE_ENTITY.withMessage(
                "Insufficient green points balance",
              ),
            );
          }
        }

        const redemption = await tx.giftRedemption.create({
          data: {
            userId,
            giftId: gift.id,
            greenPointsSpent: gift.greenPoints,
          },
        });

        if (gift.greenPoints >= 0) {
          await tx.greenPointTransaction.create({
            data: {
              userId,
              type: GreenPointTransactionType.GIFT_REDEEM,
              resourceId: redemption.id,
              resourceType: GreenPointResourceType.GIFT_REDEMPTION,
              points: -gift.greenPoints,
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
