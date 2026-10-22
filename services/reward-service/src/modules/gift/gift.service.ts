import {
  Gift,
  GiftRedemption,
  GiftRedemptionActorRole,
  GiftRedemptionEventType,
  GiftRedemptionStatus,
  Media,
  Prisma,
} from "@prisma/client";
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
  REDEEM_SOURCES_INCLUDE,
  returnToBatches,
  takeFromBatches,
  toRedemptionSources,
} from "./gift-stock.util";
import { liveLogoUrl } from "./gift-source.service";
import { generateOrderCode, normalizeOrderCode } from "./order-code.util";
import { recordEvent, toEventResponse } from "./redemption-event.util";
import {
  AdminGiftRedemptionDetailResponse,
  AdminGiftRedemptionListItemResponse,
  allowedTransitionsFor,
  GiftRedemptionDetailResponse,
  PatchGiftRedemptionStatusBody,
  transitionsFor,
  UpdateTrackingBody,
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
  /** Order code in any spelling; one that cannot be a code matches nothing. */
  code?: string;
  status?: GiftRedemptionStatus;
  sourceId?: string;
  sortBy?: "createdAt" | "greenPointsSpent" | "statusUpdatedAt";
  sortOrder?: "asc" | "desc";
};

type GiftWithMedia = Gift & { media?: { url: string; deletedAt: Date | null } | null };
type GiftRedemptionWithGift = GiftRedemption & { gift: GiftWithMedia | null };

/** An admin acts on any order by id; a customer only on their own, by order code. */
type RedemptionTarget = { id: string } | { code: string; userId: string };
type RedemptionActor = { role: GiftRedemptionActorRole; id: string | null };

export type RedemptionStatusChange = {
  redemption: GiftRedemptionResponse;
  /** False when the order was already in that status, so nothing (history included) was written. */
  changed: boolean;
};

/** `where.code` for a code filter: undefined when unfiltered, a never-matching value when invalid. */
function codeFilter(code: string | undefined): string | undefined {
  if (code === undefined || code.trim() === "") return undefined;
  return normalizeOrderCode(code) ?? "-";
}

/** Gift fields the order lists need, image included so the history can show it. */
const GIFT_WITH_MEDIA = { include: { media: { select: { url: true, deletedAt: true } } } } as const;

function toGiftSnapshot(gift: GiftWithMedia | null): GiftRedemptionGiftSnapshot | null {
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
    mediaUrl: gift.media && !gift.media.deletedAt ? gift.media.url : null,
    greenPoints: gift.greenPoints,
  };
}

function toGiftRedemptionListItem(
  r: GiftRedemptionWithGift,
  role: GiftRedemptionActorRole,
): GiftRedemptionListItemResponse {
  return {
    id: r.id,
    code: r.code,
    giftId: r.giftId,
    greenPointsSpent: r.greenPointsSpent,
    quantity: r.quantity,
    unitPoints: r.unitPoints,
    phoneNumber: r.phoneNumber,
    pickupLocation: r.pickupLocation,
    recipientName: r.recipientName,
    addressDetail: r.addressDetail,
    deliveryLatitude: r.deliveryLatitude,
    deliveryLongitude: r.deliveryLongitude,
    deliveryNote: r.deliveryNote,
    status: r.status,
    statusUpdatedAt: r.statusUpdatedAt.toISOString(),
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    gift: toGiftSnapshot(r.gift),
    cancelReason: r.cancelReason,
    carrier: r.carrier,
    trackingCode: r.trackingCode,
    shippedAt: r.shippedAt?.toISOString() ?? null,
    allowedTransitions: allowedTransitionsFor(r.status, role),
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
    params: Omit<ListGiftRedemptionsParams, "status" | "sourceId">,
  ): Promise<{ redemptions: GiftRedemptionListItemResponse[]; total: number }> {
    const { page, limit, sortBy = "createdAt", sortOrder = "desc" } = params;
    const skip = (page - 1) * limit;
    const code = codeFilter(params.code);
    const where: Prisma.GiftRedemptionWhereInput = { userId, ...(code ? { code } : {}) };

    const [rows, total] = await Promise.all([
      prisma.giftRedemption.findMany({
        where,
        orderBy: { [sortBy]: sortOrder },
        skip,
        take: limit,
        include: { gift: GIFT_WITH_MEDIA },
      }),
      prisma.giftRedemption.count({ where }),
    ]);

    const redemptions = rows.map((r) => toGiftRedemptionListItem(r, "USER"));

    return { redemptions, total };
  }

  async listRedemptionsForAdmin(
    params: ListGiftRedemptionsParams,
  ): Promise<{ redemptions: AdminGiftRedemptionListItemResponse[]; total: number }> {
    const skip = (params.page - 1) * params.limit;
    const code = codeFilter(params.code);
    const where: Prisma.GiftRedemptionWhereInput = {
      ...(code ? { code } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.sourceId
        ? { stockMovements: { some: { type: "REDEEM_OUT", batch: { sourceId: params.sourceId } } } }
        : {}),
    };
    const sortBy = params.sortBy ?? "createdAt";
    const sortOrder = params.sortOrder ?? "desc";

    const [rows, total] = await Promise.all([
      prisma.giftRedemption.findMany({
        where,
        orderBy: { [sortBy]: sortOrder },
        skip,
        take: params.limit,
        include: { gift: GIFT_WITH_MEDIA, stockMovements: REDEEM_SOURCES_INCLUDE },
      }),
      prisma.giftRedemption.count({ where }),
    ]);

    const profileMap = await fetchUsersByIds(rows.map((r) => r.userId));
    const redemptions: AdminGiftRedemptionListItemResponse[] = rows.map((r) => {
      const profile = getUserProfile(profileMap, r.userId);
      return {
        ...toGiftRedemptionListItem(r, "ADMIN"),
        userId: r.userId,
        user: profile
          ? {
              id: profile.id,
              name: profile.name,
              avatar: profile.avatar,
            }
          : null,
        sources: toRedemptionSources(r.stockMovements),
        restocked: r.restocked,
      };
    });

    return { redemptions, total };
  }

  /** The owner's view of one order with its history; null when it is not theirs (spec 017 FR-041). */
  async getMyRedemptionByCode(
    userId: string,
    rawCode: string,
  ): Promise<GiftRedemptionDetailResponse | null> {
    const code = normalizeOrderCode(rawCode);
    if (!code) return null;
    const r = await prisma.giftRedemption.findFirst({
      where: { code, userId },
      include: { gift: GIFT_WITH_MEDIA, events: { orderBy: { createdAt: "desc" } } },
    });
    if (!r) return null;
    return {
      ...toGiftRedemptionListItem(r, "USER"),
      events: r.events.map((e) => toEventResponse(e, { withActor: false })),
    };
  }

  /** Admin view: adds the account, the sources and who did each step. */
  async getAdminRedemptionByCode(rawCode: string): Promise<AdminGiftRedemptionDetailResponse | null> {
    const code = normalizeOrderCode(rawCode);
    if (!code) return null;
    const r = await prisma.giftRedemption.findFirst({
      where: { code },
      include: {
        gift: GIFT_WITH_MEDIA,
        stockMovements: REDEEM_SOURCES_INCLUDE,
        events: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!r) return null;

    const actorIds = r.events.map((e) => e.actorId).filter((id): id is string => id !== null);
    const profileMap = await fetchUsersByIds([...new Set([r.userId, ...actorIds])]);
    const actorNames = new Map(
      actorIds.map((id) => [id, getUserProfile(profileMap, id)?.name ?? null] as const),
    );
    const profile = getUserProfile(profileMap, r.userId);
    return {
      ...toGiftRedemptionListItem(r, "ADMIN"),
      userId: r.userId,
      user: profile ? { id: profile.id, name: profile.name, avatar: profile.avatar } : null,
      sources: toRedemptionSources(r.stockMovements),
      restocked: r.restocked,
      events: r.events.map((e) => toEventResponse(e, { withActor: true, actorNames })),
    };
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
    const quantity = body.quantity ?? 1;
    const phoneNumber = body.phoneNumber.trim();
    const pickupLocation = body.pickupLocation.trim();
    const delivery = {
      recipientName: body.recipientName.trim(),
      addressDetail: body.addressDetail?.trim() || null,
      deliveryLatitude: body.deliveryLatitude,
      deliveryLongitude: body.deliveryLongitude,
      deliveryNote: body.deliveryNote?.trim() || null,
    };

    // Buyers of the same gift touch the same batch and cache rows, so Serializable conflicts are
    // routine under load; the whole transaction rolls back, so running it again is safe.
    return retryOnConflict(
      () => {
        // Fresh code each attempt: a clash on the unique code aborts the transaction and is retried.
        const code = generateOrderCode();
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

            // Listed price for everyone (spec 014 FR-043: no badge discount), times the items.
            const unitPoints = gift.greenPoints;
            const total = unitPoints * quantity;
            const now = new Date();
            // Cheap early answer from the stock cache; takeFromBatches checks again on the batches.
            if (gift.stockRemaining < quantity) {
              throw new HttpError(
                HTTP_STATUS.UNPROCESSABLE_ENTITY.withMessage(
                  gift.stockRemaining <= 0 ? "Gift is out of stock" : "Not enough stock",
                ),
              );
            }
            if (total > 0 && (await getBalance(tx, userId, now)) < total) {
              throw new HttpError(
                HTTP_STATUS.UNPROCESSABLE_ENTITY.withMessage("Insufficient green points"),
              );
            }

            const created = await tx.giftRedemption.create({
              data: {
                code,
                userId,
                giftId: gift.id,
                greenPointsSpent: total,
                quantity,
                unitPoints,
                phoneNumber,
                pickupLocation,
                ...delivery,
                status: "PROCESSING",
                statusUpdatedAt: now,
              },
            });
            await recordEvent(tx, {
              redemptionId: created.id,
              type: "CREATED",
              toStatus: "PROCESSING",
              actorRole: "USER",
              actorId: userId,
              data: { quantity },
            });
            // Items from live batches (spec 015 R3, spec 018 R2); too few rolls the whole order back.
            await takeFromBatches(tx, gift.id, created.id, userId, quantity, now);
            const redemption = created;

            if (total > 0) {
              await spendLotsFifo(tx, userId, redemption.id, total, now);
              await insertLedgerOnce(tx, {
                userId,
                points: -total,
                type: GreenPointTransactionType.GIFT_REDEEM,
                resourceId: redemption.id,
                resourceType: GreenPointResourceType.GIFT_REDEMPTION,
                idempotencyKey: IdempotencyKey.giftRedeem(redemption.id),
                metadata: { giftId: gift.id, listPrice: unitPoints, quantity },
              });
            }

            return toGiftRedemptionResponse(redemption, "USER");
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      },
      (error) => isSerializationConflict(error) || isOrderCodeClash(error),
    );
  }

  /** Admin status change by order id (spec 016 R5, spec 017 shipping). */
  async updateRedemptionStatus(
    id: string,
    body: PatchGiftRedemptionStatusBody,
    adminId: string | null = null,
  ): Promise<RedemptionStatusChange | null> {
    return this.changeStatus({ id }, body, { role: "ADMIN", id: adminId });
  }

  /** The owner cancels an order not yet shipped; same refund and restock as an admin cancel. */
  async cancelMyRedemption(
    userId: string,
    rawCode: string,
    cancelReason: string,
  ): Promise<RedemptionStatusChange | null> {
    const code = normalizeOrderCode(rawCode);
    if (!code) return null;
    return this.changeStatus({ code, userId }, { status: "CANCELLED", cancelReason }, { role: "USER", id: userId });
  }

  /** The owner confirms a shipped order arrived. */
  async confirmMyRedemption(userId: string, rawCode: string): Promise<RedemptionStatusChange | null> {
    const code = normalizeOrderCode(rawCode);
    if (!code) return null;
    return this.changeStatus({ code, userId }, { status: "DELIVERED" }, { role: "USER", id: userId });
  }

  /**
   * The one place an order changes status, for admins and owners alike, so a refund or restock can
   * only happen once (spec 017 R4). Cancelling needs a reason; an admin cancelling a SHIPPED order also
   * says whether the item came back; shipping needs carrier + tracking code. Repeating the current
   * status changes nothing and writes no history, except a re-ship carrying a different tracking code,
   * which is refused so that value is not silently dropped.
   */
  async changeStatus(
    target: RedemptionTarget,
    body: PatchGiftRedemptionStatusBody,
    actor: RedemptionActor,
  ): Promise<RedemptionStatusChange | null> {
    const nextStatus = body.status;
    // Refunds of one user's orders touch the same lots, so conflicts happen; rerunning is safe.
    return retryOnConflict(() =>
      prisma.$transaction(
        async (tx) => {
          // Row lock: a second request on the same order waits, then sees the new status below.
          const locked =
            "id" in target
              ? await tx.$queryRaw<{ id: string }[]>`SELECT id FROM gift_redemptions WHERE id = ${target.id}::uuid FOR UPDATE`
              : await tx.$queryRaw<{ id: string }[]>`SELECT id FROM gift_redemptions WHERE code = ${target.code} AND user_id = ${target.userId}::uuid FOR UPDATE`;
          if (!locked?.length) {
            return null;
          }
          const redemption = await tx.giftRedemption.findUnique({ where: { id: locked[0].id } });
          if (!redemption) {
            return null;
          }
          const result = (row: GiftRedemption, changed: boolean): RedemptionStatusChange => ({
            redemption: toGiftRedemptionResponse(row, actor.role),
            changed,
          });

          if (redemption.status === nextStatus) {
            if (nextStatus === "SHIPPED" && trackingDiffers(redemption, body)) {
              throw new HttpError(
                HTTP_STATUS.CONFLICT.withMessage("Order was already shipped by someone else"),
              );
            }
            return result(redemption, false);
          }

          if (!transitionsFor(actor.role)[redemption.status].includes(nextStatus)) {
            throw new HttpError(
              HTTP_STATUS.UNPROCESSABLE_ENTITY.withMessage(
                `Cannot change redemption status from ${redemption.status} to ${nextStatus}`,
              ),
            );
          }

          const now = new Date();
          const shipping = nextStatus === "SHIPPED" ? { ...parseTracking(body), shippedAt: now } : {};
          const cancelling = nextStatus === "CANCELLED";
          let restock = false;
          let cancelReason: string | null = null;
          if (cancelling) {
            cancelReason = body.cancelReason?.trim() ?? "";
            if (cancelReason.length < 1 || cancelReason.length > 500) {
              throw fieldError("cancelReason", "Cancel reason must be 1 to 500 characters");
            }
            if (redemption.status === "SHIPPED" && typeof body.restock !== "boolean") {
              throw fieldError("restock", "Choose whether the item came back to stock");
            }
            // An order still being prepared always goes back to stock (spec 016 FR-034).
            restock = redemption.status === "PROCESSING" ? true : body.restock === true;
          }

          // Every item back to the batch it came from (spec 018 R3); 0 for orders before spec 015.
          const returnedQuantity = cancelling && restock ? await returnToBatches(tx, redemption, actor.id, now) : 0;
          const updated = await tx.giftRedemption.update({
            where: { id: redemption.id },
            data: {
              status: nextStatus,
              statusUpdatedAt: now,
              cancelledAt: cancelling ? now : null,
              ...shipping,
              ...(cancelling ? { cancelReason, restocked: returnedQuantity > 0 } : {}),
            },
          });

          if (cancelling && redemption.greenPointsSpent > 0) {
            await refundRedemptionPoints(tx, redemption, now);
          }

          await recordEvent(tx, {
            redemptionId: redemption.id,
            type: nextStatus as GiftRedemptionEventType,
            fromStatus: redemption.status,
            toStatus: nextStatus,
            actorRole: actor.role,
            actorId: actor.id,
            data:
              nextStatus === "SHIPPED"
                ? { carrier: updated.carrier, trackingCode: updated.trackingCode }
                : cancelling
                  ? { cancelReason, restocked: updated.restocked, returnedQuantity }
                  : null,
          });

          return result(updated, true);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  /** What the "order shipped" notification needs; gift names fall back to the base name per language. */
  async getShippedNotificationData(id: string): Promise<{
    userId: string;
    orderCode: string;
    giftNameEn: string;
    giftNameVi: string;
    carrier: string;
    trackingCode: string;
    quantity: number;
  } | null> {
    const r = await prisma.giftRedemption.findUnique({ where: { id }, include: { gift: true } });
    if (!r || r.status !== "SHIPPED" || !r.carrier || !r.trackingCode) return null;
    return {
      userId: r.userId,
      orderCode: r.code,
      giftNameEn: r.gift.nameEn ?? r.gift.name,
      giftNameVi: r.gift.nameVi ?? r.gift.name,
      carrier: r.carrier,
      trackingCode: r.trackingCode,
      quantity: r.quantity,
    };
  }

  /** Fix a mistyped carrier or tracking code while the order is SHIPPED (spec 017 FR-012). */
  async updateTracking(
    id: string,
    body: UpdateTrackingBody,
    adminId: string | null,
  ): Promise<GiftRedemptionResponse | null> {
    return retryOnConflict(() =>
      prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM gift_redemptions WHERE id = ${id}::uuid FOR UPDATE`;
          const redemption = await tx.giftRedemption.findUnique({ where: { id } });
          if (!redemption) {
            return null;
          }
          if (redemption.status !== "SHIPPED") {
            throw new HttpError(
              HTTP_STATUS.UNPROCESSABLE_ENTITY.withMessage(
                "Tracking can only be changed while the order is SHIPPED",
              ),
            );
          }
          const next = parseTracking(body);
          if (next.carrier === redemption.carrier && next.trackingCode === redemption.trackingCode) {
            return toGiftRedemptionResponse(redemption);
          }
          const updated = await tx.giftRedemption.update({ where: { id }, data: next });
          await recordEvent(tx, {
            redemptionId: id,
            type: "TRACKING_UPDATED",
            actorRole: "ADMIN",
            actorId: adminId,
            data: {
              ...next,
              previousCarrier: redemption.carrier,
              previousTrackingCode: redemption.trackingCode,
            },
          });
          return toGiftRedemptionResponse(updated);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }
}

const TRACKING_CODE_PATTERN = /^[A-Za-z0-9._/-]{1,100}$/;

/** Carrier 1–100 chars; tracking code 1–100 of A-Z a-z 0-9 . _ / - (spec 017 FR-010). */
function parseTracking(body: { carrier?: string; trackingCode?: string }): {
  carrier: string;
  trackingCode: string;
} {
  const carrier = typeof body.carrier === "string" ? body.carrier.trim() : "";
  if (carrier.length < 1 || carrier.length > 100) {
    throw fieldError("carrier", "Carrier is required (at most 100 characters)");
  }
  const trackingCode = typeof body.trackingCode === "string" ? body.trackingCode.trim() : "";
  if (!TRACKING_CODE_PATTERN.test(trackingCode)) {
    throw fieldError("trackingCode", "Tracking code is required: 1–100 letters, digits or . _ / -");
  }
  return { carrier, trackingCode };
}

/** A re-ship that names another carrier or code than the one saved. */
function trackingDiffers(
  saved: GiftRedemption,
  body: { carrier?: string; trackingCode?: string },
): boolean {
  const carrier = body.carrier?.trim();
  const trackingCode = body.trackingCode?.trim();
  return (
    (carrier !== undefined && carrier !== saved.carrier) ||
    (trackingCode !== undefined && trackingCode !== saved.trackingCode)
  );
}

const TX_ATTEMPTS = 15;

/**
 * Runs a Serializable transaction again after a conflict, with capped full jitter (50 concurrent
 * buyers of one gift settle within about 2 seconds); gives up with 409 after TX_ATTEMPTS.
 */
async function retryOnConflict<T>(
  run: () => Promise<T>,
  isRetryable: (error: unknown) => boolean = isSerializationConflict,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isRetryable(error)) throw error;
      if (attempt >= TX_ATTEMPTS) {
        throw new HttpError(HTTP_STATUS.CONFLICT.withMessage("Please retry"));
      }
      await new Promise((r) => setTimeout(r, Math.random() * Math.min(250, 10 * 2 ** attempt)));
    }
  }
}

/** A 400 in express-validator's shape, so the client maps it onto the field like any other. */
const fieldError = (path: string, msg: string): HttpError =>
  new HttpError(HTTP_STATUS.VALIDATION_ERROR.withMessage(msg), {
    errors: [{ type: "field", path, location: "body", msg }],
  });

/** Postgres 40001/40P01, as Prisma reports it for model calls (P2034) and raw queries (P2010). */
/** P2002 on the order code: two orders drew the same code; the caller retries with a new one. */
function isOrderCodeClash(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  return JSON.stringify(error.meta?.target ?? "").includes("code");
}

function isSerializationConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;
  const dbCode = (error.meta as { code?: string } | undefined)?.code;
  return error.code === "P2010" && (dbCode === "40001" || dbCode === "40P01");
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
