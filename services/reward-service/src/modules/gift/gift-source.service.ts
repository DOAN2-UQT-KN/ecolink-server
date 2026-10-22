import { randomUUID } from "crypto";
import type {
  GiftSource,
  GiftSourceStatus,
  GiftSourceType,
  Media,
  Prisma,
} from "@prisma/client";
import prisma from "../../config/prisma.client";
import { HTTP_STATUS, HttpError } from "../../constants/http-status";
import { toStockBatchResponse, type StockBatchResponse } from "./gift-stock.util";

export type GiftSourceResponse = {
  id: string;
  name: string;
  type: GiftSourceType;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  logo: { id: string; url: string } | null;
  showOnGift: boolean;
  status: GiftSourceStatus;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  batchCount: number;
};

export type GiftSourceBody = {
  name?: string;
  type?: GiftSourceType;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  /** URL of an uploaded logo; "" removes the logo. */
  logoUrl?: string;
  showOnGift?: boolean;
  status?: GiftSourceStatus;
  note?: string | null;
};

type SourceRow = GiftSource & { logo: Media | null; _count: { batches: number } };

const sourceInclude = { logo: true, _count: { select: { batches: true } } } as const;

/** A soft-deleted media row counts as no logo. */
export const liveLogoUrl = (logo: { url: string; deletedAt: Date | null } | null): string | null =>
  logo && !logo.deletedAt ? logo.url : null;

export function toGiftSourceResponse(row: SourceRow): GiftSourceResponse {
  const url = liveLogoUrl(row.logo);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    contactEmail: row.contactEmail,
    logo: url && row.logo ? { id: row.logo.id, url } : null,
    showOnGift: row.showOnGift,
    status: row.status,
    note: row.note,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    batchCount: row._count.batches,
  };
}

const notFound = () => new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Gift source not found"));

const trimOrNull = (v: string | null | undefined) =>
  v === undefined ? undefined : v === null ? null : v.trim() || null;

async function logoData(
  tx: Prisma.TransactionClient,
  logoUrl: string | undefined,
): Promise<{ logoMediaId?: string | null }> {
  if (logoUrl === undefined) return {};
  if (!logoUrl.trim()) return { logoMediaId: null };
  const media = await tx.media.create({
    data: { id: randomUUID(), url: logoUrl.trim(), type: "GIFT_SOURCE_LOGO" },
  });
  return { logoMediaId: media.id };
}

export class GiftSourceService {
  async list(params: {
    page: number;
    limit: number;
    type?: GiftSourceType;
    status?: GiftSourceStatus;
    search?: string;
  }): Promise<{ sources: GiftSourceResponse[]; total: number }> {
    const q = params.search?.trim();
    const where: Prisma.GiftSourceWhereInput = {
      ...(params.type ? { type: params.type } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.giftSource.findMany({
        where,
        include: sourceInclude,
        orderBy: { createdAt: "desc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.giftSource.count({ where }),
    ]);
    return { sources: rows.map(toGiftSourceResponse), total };
  }

  async getById(id: string): Promise<GiftSourceResponse> {
    const row = await prisma.giftSource.findUnique({ where: { id }, include: sourceInclude });
    if (!row) throw notFound();
    return toGiftSourceResponse(row);
  }

  async create(body: GiftSourceBody & { name: string; type: GiftSourceType }, adminId: string | null) {
    const row = await prisma.$transaction(async (tx) =>
      tx.giftSource.create({
        data: {
          name: body.name.trim(),
          type: body.type,
          contactName: trimOrNull(body.contactName) ?? null,
          contactPhone: trimOrNull(body.contactPhone) ?? null,
          contactEmail: trimOrNull(body.contactEmail) ?? null,
          showOnGift: body.showOnGift ?? false,
          note: trimOrNull(body.note) ?? null,
          createdBy: adminId,
          ...(await logoData(tx, body.logoUrl)),
        },
        include: sourceInclude,
      }),
    );
    return toGiftSourceResponse(row);
  }

  async update(id: string, body: GiftSourceBody): Promise<GiftSourceResponse> {
    const exists = await prisma.giftSource.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw notFound();
    const row = await prisma.$transaction(async (tx) =>
      tx.giftSource.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name.trim() } : {}),
          ...(body.type !== undefined ? { type: body.type } : {}),
          ...(body.contactName !== undefined ? { contactName: trimOrNull(body.contactName) } : {}),
          ...(body.contactPhone !== undefined ? { contactPhone: trimOrNull(body.contactPhone) } : {}),
          ...(body.contactEmail !== undefined ? { contactEmail: trimOrNull(body.contactEmail) } : {}),
          ...(body.showOnGift !== undefined ? { showOnGift: body.showOnGift } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          ...(body.note !== undefined ? { note: trimOrNull(body.note) } : {}),
          ...(await logoData(tx, body.logoUrl)),
        },
        include: sourceInclude,
      }),
    );
    return toGiftSourceResponse(row);
  }

  /** Batches received from a source, newest first, with their gift (spec 015 FR-006). */
  async listBatches(
    sourceId: string,
    params: { page: number; limit: number },
  ): Promise<{ batches: Array<StockBatchResponse & { gift: { id: string; name: string } }>; total: number }> {
    const exists = await prisma.giftSource.findUnique({ where: { id: sourceId }, select: { id: true } });
    if (!exists) throw notFound();
    const where = { sourceId };
    const [rows, total] = await Promise.all([
      prisma.giftStockBatch.findMany({
        where,
        include: { gift: { select: { id: true, name: true, nameVi: true } } },
        orderBy: [{ receivedAt: "desc" }, { id: "asc" }],
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.giftStockBatch.count({ where }),
    ]);
    const now = new Date();
    return {
      batches: rows.map((b) => ({
        ...toStockBatchResponse(b, now),
        gift: { id: b.gift.id, name: b.gift.nameVi ?? b.gift.name },
      })),
      total,
    };
  }
}

export const giftSourceService = new GiftSourceService();
