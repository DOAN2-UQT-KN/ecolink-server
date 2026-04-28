import { Prisma } from "@prisma/client";
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
        name: { contains: q, mode: "insensitive" },
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
        include: { media: true },
      }),
      prisma.gift.count({ where }),
    ]);

    return { gifts: rows.map(toGiftResponse), total };
  }

  async getGiftById(id: string): Promise<GiftResponse | null> {
    const row = await prisma.gift.findFirst({
      where: { id, deletedAt: null },
      include: { media: true },
    });
    return row ? toGiftResponse(row) : null;
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
            description: r.gift.description,
            mediaId: r.gift.mediaId,
            greenPoints: r.gift.greenPoints,
          }
        : null,
    }));

    return { redemptions, total };
  }

  async create(body: CreateGiftBody): Promise<GiftResponse> {
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
          mediaId,
          description: body.description.trim(),
          greenPoints: body.greenPoints,
          stockRemaining:
            body.stockRemaining === undefined ? null : body.stockRemaining,
          isActive: body.isActive ?? true,
        },
        include: { media: true },
      });
    });
    return toGiftResponse(row);
  }

  async updateById(
    id: string,
    body: UpdateGiftBody,
  ): Promise<GiftResponse | null> {
    const existing = await prisma.gift.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) {
      return null;
    }

    const data: Prisma.GiftUpdateInput = {
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.description !== undefined
        ? { description: body.description.trim() }
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
        include: { media: true },
      });
      return unchanged ? toGiftResponse(unchanged) : null;
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
        include: { media: true },
      });
    });
    return toGiftResponse(updated);
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

        if (gift.greenPoints > 0) {
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
