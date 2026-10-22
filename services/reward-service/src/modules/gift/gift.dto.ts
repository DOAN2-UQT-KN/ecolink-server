import {
  Gift,
  GiftRedemption,
  GiftRedemptionActorRole,
  GiftRedemptionEventType,
  GiftRedemptionStatus,
  Media,
} from "@prisma/client";

/** Order state machine (spec 016 US4); the client renders buttons from `allowedTransitions` only. */
export const REDEMPTION_STATUS_TRANSITIONS: Record<GiftRedemptionStatus, GiftRedemptionStatus[]> = {
  PROCESSING: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED", "CANCELLED"],
  DELIVERED: [],
  CANCELLED: [],
};

/** What the order's owner may do themselves (spec 017): cancel before shipping, confirm delivery. */
export const USER_REDEMPTION_TRANSITIONS: Record<GiftRedemptionStatus, GiftRedemptionStatus[]> = {
  PROCESSING: ["CANCELLED"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
};

export const transitionsFor = (role: GiftRedemptionActorRole) =>
  role === "USER" ? USER_REDEMPTION_TRANSITIONS : REDEMPTION_STATUS_TRANSITIONS;

export const allowedTransitionsFor = (
  status: GiftRedemptionStatus,
  role: GiftRedemptionActorRole = "ADMIN",
): GiftRedemptionStatus[] => [...transitionsFor(role)[status]];

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
  /** Items left in live batches (spec 015 FR-020); never null. */
  stockRemaining: number;
  isActive: boolean;
  /** Sources shown as "Sponsored by": showOnGift with a live batch of this gift. */
  sponsors: GiftSponsorResponse[];
  /** Admin only: items in live batches expiring within 7 days; null otherwise. */
  expiringSoon: { quantity: number; earliestAt: string } | null;
}

export interface GiftSponsorResponse {
  id: string;
  name: string;
  logoUrl: string | null;
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
  sponsors: [],
  expiringSoon: null,
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
  isActive?: boolean;
}

export interface GiftRedemptionResponse {
  id: string;
  code: string;
  giftId: string;
  /** Total = unitPoints * quantity. */
  greenPointsSpent: number;
  quantity: number;
  unitPoints: number;
  phoneNumber: string;
  pickupLocation: string;
  /** Delivery details; null on orders made before they were asked for. */
  recipientName: string | null;
  addressDetail: string | null;
  deliveryLatitude: number | null;
  deliveryLongitude: number | null;
  deliveryNote: string | null;
  status: GiftRedemptionStatus;
  statusUpdatedAt: string;
  cancelledAt: string | null;
  createdAt: string;
  cancelReason: string | null;
  /** Whether the item went back to stock on cancel; null unless cancelled. */
  restocked: boolean | null;
  carrier: string | null;
  trackingCode: string | null;
  shippedAt: string | null;
  allowedTransitions: GiftRedemptionStatus[];
}

export const toGiftRedemptionResponse = (
  row: GiftRedemption,
  role: GiftRedemptionActorRole = "ADMIN",
): GiftRedemptionResponse => ({
  id: row.id,
  code: row.code,
  giftId: row.giftId,
  greenPointsSpent: row.greenPointsSpent,
  quantity: row.quantity,
  unitPoints: row.unitPoints,
  phoneNumber: row.phoneNumber,
  pickupLocation: row.pickupLocation,
  recipientName: row.recipientName,
  addressDetail: row.addressDetail,
  deliveryLatitude: row.deliveryLatitude,
  deliveryLongitude: row.deliveryLongitude,
  deliveryNote: row.deliveryNote,
  status: row.status,
  statusUpdatedAt: row.statusUpdatedAt.toISOString(),
  cancelledAt: row.cancelledAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  cancelReason: row.cancelReason,
  restocked: row.restocked,
  carrier: row.carrier,
  trackingCode: row.trackingCode,
  shippedAt: row.shippedAt?.toISOString() ?? null,
  allowedTransitions: allowedTransitionsFor(row.status, role),
});

/** Most items of one gift in a single order (spec 018). */
export const MAX_REDEEM_QUANTITY = 10;

export interface RedemptionSource {
  id: string;
  name: string;
  quantity: number;
}

export interface RedeemGiftBody {
  /** 1..MAX_REDEEM_QUANTITY; 1 when the caller does not send it. */
  quantity?: number;
  /** Vietnamese mobile, digits only after sanitising: 0 + 9 digits or +84 + 9 digits. */
  phoneNumber: string;
  recipientName: string;
  /** Address picked on the Goong map. */
  pickupLocation: string;
  /** House number, building, floor, room. */
  addressDetail?: string | null;
  deliveryLatitude: number;
  deliveryLongitude: number;
  deliveryNote?: string | null;
}

/** Query string for `GET /api/v1/gifts` (pagination + filters). */
export interface GiftListQuery {
  page?: number;
  limit?: number;
  /** Case-insensitive substring match on `name`. */
  search?: string;
  /**
   * When `true`, only gifts whose stock cache (`stock_remaining`) is > 0.
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
  /** Gift image URL; null when the gift has none or it was removed. */
  mediaUrl: string | null;
  greenPoints: number;
}

export interface GiftRedemptionListItemResponse {
  id: string;
  code: string;
  userId?: string;
  giftId: string;
  /** Total = unitPoints * quantity. */
  greenPointsSpent: number;
  quantity: number;
  unitPoints: number;
  phoneNumber: string;
  pickupLocation: string;
  /** Delivery details; null on orders made before they were asked for. */
  recipientName: string | null;
  addressDetail: string | null;
  deliveryLatitude: number | null;
  deliveryLongitude: number | null;
  deliveryNote: string | null;
  status: GiftRedemptionStatus;
  statusUpdatedAt: string;
  cancelledAt: string | null;
  createdAt: string;
  gift: GiftRedemptionGiftSnapshot | null;
  cancelReason: string | null;
  carrier: string | null;
  trackingCode: string | null;
  shippedAt: string | null;
  /** Computed for the caller's role: the owner's actions on /me, the admin's on /admin. */
  allowedTransitions: GiftRedemptionStatus[];
}

/** One line of the order history; `actor` only in the admin view (spec 017 FR-041). */
export interface GiftRedemptionEventResponse {
  id: string;
  type: GiftRedemptionEventType;
  fromStatus: GiftRedemptionStatus | null;
  toStatus: GiftRedemptionStatus | null;
  actorRole: GiftRedemptionActorRole;
  actor?: { id: string; name: string | null } | null;
  data: Record<string, unknown> | null;
  reconstructed: boolean;
  createdAt: string;
}

export interface GiftRedemptionDetailResponse extends GiftRedemptionListItemResponse {
  /** Newest first. */
  events: GiftRedemptionEventResponse[];
}

export interface GiftRedemptionUserSnapshot {
  id: string;
  name: string;
  avatar: string | null;
}

export interface AdminGiftRedemptionListItemResponse
  extends GiftRedemptionListItemResponse {
  userId: string;
  user: GiftRedemptionUserSnapshot | null;
  /** Sources the items came from, with how many from each; empty for orders before spec 015. */
  sources: RedemptionSource[];
  restocked: boolean | null;
}

export interface AdminGiftRedemptionDetailResponse extends AdminGiftRedemptionListItemResponse {
  events: GiftRedemptionEventResponse[];
}

export interface MyGreenPointsEnvelopeData {
  balance: number;
}

export interface MyGiftRedemptionsQuery {
  page?: number;
  limit?: number;
  /** Order code, any case, with or without "EL-". */
  code?: string;
  sortBy?: "createdAt" | "greenPointsSpent" | "statusUpdatedAt";
  sortOrder?: "asc" | "desc";
}

export interface MyGiftRedemptionsEnvelopeData extends GiftListMeta {
  redemptions: GiftRedemptionListItemResponse[];
}

export interface AdminGiftRedemptionsQuery extends MyGiftRedemptionsQuery {
  status?: GiftRedemptionStatus;
  sourceId?: string;
}

export interface MyGiftRedemptionDetailEnvelopeData {
  redemption: GiftRedemptionDetailResponse;
}

export interface AdminGiftRedemptionDetailEnvelopeData {
  redemption: AdminGiftRedemptionDetailResponse;
}

export interface CancelMyRedemptionBody {
  /** 1–500 characters. */
  cancelReason: string;
}

export interface AdminGiftRedemptionsEnvelopeData extends GiftListMeta {
  redemptions: AdminGiftRedemptionListItemResponse[];
}

export interface PatchGiftRedemptionStatusBody {
  status: GiftRedemptionStatus;
  /** Required (1–500 chars) when cancelling. */
  cancelReason?: string;
  /** Required when cancelling a SHIPPED order; ignored for PROCESSING (always restocked). */
  restock?: boolean;
  /** Required (1–100 chars) when shipping. */
  carrier?: string;
  /** Required when shipping: 1–100 of A-Z a-z 0-9 . _ / - */
  trackingCode?: string;
}

export interface UpdateTrackingBody {
  carrier: string;
  trackingCode: string;
}
