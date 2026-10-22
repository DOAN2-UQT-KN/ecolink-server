/** OpenAPI shapes for gift sources and batch stock (spec 015 contracts/api.md). */

export interface GiftSourceDto {
  id: string;
  name: string;
  type: "SPONSOR" | "ECOLINK" | "DONATION";
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  logo: { id: string; url: string } | null;
  showOnGift: boolean;
  status: "ACTIVE" | "INACTIVE";
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  batchCount: number;
}

export interface GiftSourceListQuery {
  page?: number;
  limit?: number;
  type?: "SPONSOR" | "ECOLINK" | "DONATION";
  status?: "ACTIVE" | "INACTIVE";
  search?: string;
}

export interface CreateGiftSourceBody {
  name: string;
  type: "SPONSOR" | "ECOLINK" | "DONATION";
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  /** Uploaded logo URL. */
  logoUrl?: string;
  showOnGift?: boolean;
  note?: string;
}

export interface UpdateGiftSourceBody {
  name?: string;
  type?: "SPONSOR" | "ECOLINK" | "DONATION";
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  /** Uploaded logo URL; "" removes the logo. */
  logoUrl?: string;
  showOnGift?: boolean;
  /** INACTIVE stops new batches from this source. */
  status?: "ACTIVE" | "INACTIVE";
  note?: string | null;
}

export interface GiftSourceOneEnvelopeData {
  source: GiftSourceDto;
}

export interface GiftSourcesListEnvelopeData {
  sources: GiftSourceDto[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface StockBatchDto {
  id: string;
  giftId: string;
  source?: { id: string; name: string; type: string; status: string };
  gift?: { id: string; name: string };
  quantity: number;
  remaining: number;
  unitValueVnd: number;
  receivedAt: string;
  expiresAt: string | null;
  reference: string;
  attachmentUrls: string[];
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  state: "IN_STOCK" | "OUT_OF_STOCK" | "EXPIRING_SOON" | "EXPIRED";
}

export interface StockBatchListQuery {
  page?: number;
  limit?: number;
  sourceId?: string;
}

export interface StockBatchesListEnvelopeData {
  batches: StockBatchDto[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface CreateStockBatchBody {
  sourceId: string;
  quantity: number;
  unitValueVnd: number;
  /** ISO date-time, not in the future. */
  receivedAt: string;
  /** ISO date-time after receivedAt. */
  expiresAt?: string | null;
  /** Document number; may be empty when attachmentUrls has at least one file. */
  reference?: string;
  /** Uploaded proof files, at most 5 http(s) URLs. */
  attachmentUrls?: string[];
  note?: string | null;
}

export interface StockBatchCreatedEnvelopeData {
  batch: StockBatchDto;
  stockRemaining: number;
}

export interface AdjustStockBatchBody {
  quantity: number;
  reason: "DAMAGED" | "LOST" | "COUNT_SHORTAGE" | "RETURN_TO_SOURCE";
  note?: string | null;
}

export interface StockMovementDto {
  id: string;
  giftId: string;
  batchId: string;
  sourceName?: string;
  type: "STOCK_IN" | "REDEEM_OUT" | "CANCEL_RETURN" | "ADJUST_OUT" | "EXPIRED";
  quantity: number;
  reason: "DAMAGED" | "LOST" | "COUNT_SHORTAGE" | "RETURN_TO_SOURCE" | null;
  note: string | null;
  redemptionId: string | null;
  actor?: { id: string; name: string } | null;
  createdAt: string;
}

export interface StockAdjustedEnvelopeData {
  batch: StockBatchDto;
  movement: StockMovementDto;
  stockRemaining: number;
}

export interface StockMovementListQuery {
  page?: number;
  limit?: number;
  batchId?: string;
  type?: "STOCK_IN" | "REDEEM_OUT" | "CANCEL_RETURN" | "ADJUST_OUT" | "EXPIRED";
}

export interface StockMovementsListEnvelopeData {
  movements: StockMovementDto[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface GiftSourceReportQuery {
  /** YYYY-MM-DD in UTC+7; default 30 days before `to`. */
  from?: string;
  /** YYYY-MM-DD in UTC+7, inclusive; default today. */
  to?: string;
  format?: "json" | "csv";
}

export interface GiftSourceReportRowDto {
  received: number;
  delivered: number;
  holding: number;
  shrinkage: { DAMAGED: number; LOST: number; COUNT_SHORTAGE: number; RETURN_TO_SOURCE: number };
  expired: number;
  inStock: number;
  valueDeliveredVnd: number;
  recipients: number;
}

export interface GiftSourceReportEnvelopeData {
  report: {
    sourceId: string;
    from: string;
    to: string;
    totals: GiftSourceReportRowDto;
    gifts: Array<GiftSourceReportRowDto & { giftId: string; giftName: string }>;
  };
}
