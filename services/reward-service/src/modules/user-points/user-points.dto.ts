import { GreenPointTransaction } from "@prisma/client";

export interface MyPointsResponse {
  /** Points left in unexpired lots: what can be spent on gifts. */
  balance: number;
  /** Sum of all earnings; redemptions, expiry and refunds do not change it. */
  earnedTotal: number;
  /** Points in lots expiring within 7 days, and the earliest expiry (ISO) or null. */
  expiringSoon: { amount: number; earliestAt: string | null };
  /** @deprecated Equals `balance`; removed in the cleanup release. */
  spendablePoints: number;
  /** @deprecated Equals `balance`; removed in the cleanup release. */
  greenPoints: number;
  /** @deprecated Equals `earnedTotal`; removed in the cleanup release. */
  greenPointsEarnedTotal: number;
}

export interface MyPointsEnvelopeData {
  data: MyPointsResponse;
}

export interface PointsTransactionResponse {
  id: string;
  userId: string;
  type: string;
  resourceId: string;
  resourceType: string;
  resource?: Record<string, unknown> | null;
  points: number;
  createdAt: string;
  updatedAt: string;
}

export const toPointsTransactionResponse = (row: GreenPointTransaction): PointsTransactionResponse => ({
  id: row.id,
  userId: row.userId,
  type: row.type,
  resourceId: row.resourceId,
  resourceType: row.resourceType,
  points: row.points,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export interface MyPointsTransactionsQuery {
  page?: number;
  limit?: number;
  type?: string;
  sortBy?: "createdAt" | "points" | "type";
  sortOrder?: "asc" | "desc";
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface MyPointsTransactionsEnvelopeData extends PaginationMeta {
  transactions: PointsTransactionResponse[];
}
