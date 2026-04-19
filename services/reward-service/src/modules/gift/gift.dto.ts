import { Gift, GiftRedemption } from "@prisma/client";

export interface GiftResponse {
  id: string;
  name: string;
  mediaId: string;
  description: string;
  greenPoints: number;
  stockRemaining: number | null;
  isActive: boolean;
}

export const toGiftResponse = (row: Gift): GiftResponse => ({
  id: row.id,
  name: row.name,
  mediaId: row.mediaId,
  description: row.description,
  greenPoints: row.greenPoints,
  stockRemaining: row.stockRemaining,
  isActive: row.isActive,
});

export interface CreateGiftBody {
  name: string;
  mediaId: string;
  description: string;
  greenPoints: number;
  stockRemaining?: number | null;
  isActive?: boolean;
}

export interface UpdateGiftBody {
  name?: string;
  mediaId?: string;
  description?: string;
  greenPoints?: number;
  stockRemaining?: number | null;
  isActive?: boolean;
}

export interface GiftRedemptionResponse {
  id: string;
  giftId: string;
  greenPointsSpent: number;
  createdAt: string;
}

export const toGiftRedemptionResponse = (
  row: GiftRedemption,
): GiftRedemptionResponse => ({
  id: row.id,
  giftId: row.giftId,
  greenPointsSpent: row.greenPointsSpent,
  createdAt: row.createdAt.toISOString(),
});

/** Query string for `GET /api/v1/gifts` (pagination + filters). */
export interface GiftListQuery {
  page?: number;
  limit?: number;
  /** Case-insensitive substring match on `name`. */
  search?: string;
  /**
   * When `true`, only gifts with unlimited stock (`stock_remaining` null) or remaining stock > 0.
   */
  inStock?: boolean;
  /**
   * Filter by active flag (admin + valid JWT only; ignored for anonymous/non-admin).
   */
  isActive?: boolean;
  greenPointsMin?: number;
  greenPointsMax?: number;
}

export interface GiftListMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** OpenAPI / success envelope */
export interface GiftsListEnvelopeData {
  gifts: GiftResponse[];
  meta: GiftListMeta;
}

export interface GiftOneEnvelopeData {
  gift: GiftResponse;
}

export interface GiftRedemptionOneEnvelopeData {
  redemption: GiftRedemptionResponse;
}

/** Snapshot of the gift at list time (for volunteer redemption history). */
export interface GiftRedemptionGiftSnapshot {
  id: string;
  name: string;
  description: string;
  mediaId: string;
  greenPoints: number;
}

export interface GiftRedemptionListItemResponse {
  id: string;
  giftId: string;
  greenPointsSpent: number;
  createdAt: string;
  gift: GiftRedemptionGiftSnapshot | null;
}

export interface MyGreenPointsEnvelopeData {
  balance: number;
}

export interface MyGiftRedemptionsQuery {
  page?: number;
  limit?: number;
}

export interface MyGiftRedemptionsEnvelopeData {
  redemptions: GiftRedemptionListItemResponse[];
  meta: GiftListMeta;
}
