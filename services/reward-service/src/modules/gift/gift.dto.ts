import { Gift, GiftRedemption, Media } from "@prisma/client";

type GiftWithOptionalMedia = Gift & {
  media?: Media | null;
};

export interface GiftResponse {
  id: string;
  name: string | null;
  nameVi?: string | null;
  nameEn?: string | null;
  mediaId: string | null;
  media: {
    id: string;
    url: string;
    type: string;
  } | null;
  description: string | null;
  descriptionVi?: string | null;
  descriptionEn?: string | null;
  greenPoints: number;
  stockRemaining: number | null;
  isActive: boolean;
}

export const toGiftResponse = (row: GiftWithOptionalMedia): GiftResponse => ({
  id: row.id,
  name: row.name,
  nameVi: row.nameVi ?? row.name,
  nameEn: row.nameEn,
  mediaId: row.mediaId,
  media: row.media
    ? {
        id: row.media.id,
        url: row.media.url,
        type: row.media.type,
      }
    : null,
  description: row.description,
  descriptionVi: row.descriptionVi ?? row.description,
  descriptionEn: row.descriptionEn,
  greenPoints: row.greenPoints,
  stockRemaining: row.stockRemaining,
  isActive: row.isActive,
});

export interface CreateGiftBody {
  name: string;
  nameVi?: string;
  nameEn?: string;
  imageUrl?: string;
  description: string;
  descriptionVi?: string;
  descriptionEn?: string;
  greenPoints: number;
  stockRemaining?: number | null;
  isActive?: boolean;
}

export interface UpdateGiftBody {
  name?: string;
  nameVi?: string;
  nameEn?: string;
  imageUrl?: string;
  description?: string;
  descriptionVi?: string;
  descriptionEn?: string;
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
  sortBy?: "createdAt" | "name" | "greenPoints";
  sortOrder?: "asc" | "desc";
}

export interface GiftListMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** OpenAPI / success envelope */
export interface GiftsListEnvelopeData extends GiftListMeta {
  gifts: GiftResponse[];
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
  nameVi?: string | null;
  nameEn?: string | null;
  description: string;
  descriptionVi?: string | null;
  descriptionEn?: string | null;
  mediaId: string | null;
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
  sortBy?: "createdAt" | "greenPointsSpent";
  sortOrder?: "asc" | "desc";
}

export interface MyGiftRedemptionsEnvelopeData extends GiftListMeta {
  redemptions: GiftRedemptionListItemResponse[];
}
