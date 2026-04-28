import { GreenPointTransaction } from "@prisma/client";

export interface MyPointsResponse {
  balance: number;
  greenPoints: number;
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

export interface LeaderboardQuery {
  page?: number;
  limit?: number;
}

export interface LeaderboardUser {
  id: string;
  name: string;
  avatar: string | null;
}

export interface LeaderboardItemResponse {
  userId: string;
  greenPoints: number;
  user: LeaderboardUser | null;
}

export interface LeaderboardEnvelopeData extends PaginationMeta {
  leaderboard: LeaderboardItemResponse[];
}

export interface LeaderboardMeResponse {
  rank: number;
  greenPoints: number;
}

export interface LeaderboardMeEnvelopeData {
  leaderboardMe: LeaderboardMeResponse | null;
}
