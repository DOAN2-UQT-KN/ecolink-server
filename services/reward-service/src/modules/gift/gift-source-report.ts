import type { GiftStockAdjustReason } from "@prisma/client";
import prisma from "../../config/prisma.client";
import { HTTP_STATUS, HttpError } from "../../constants/http-status";
import { isLive } from "./gift-stock.util";

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_RANGE_DAYS = 30;

export type ReportRange = { from: string; to: string; start: Date; end: Date };

const vnDate = (d: Date) => new Date(d.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);

function parseDay(value: string, field: string): Date {
  const start = new Date(`${value}T00:00:00.000+07:00`);
  if (!DATE_RE.test(value) || Number.isNaN(start.getTime()) || vnDate(start) !== value) {
    throw new HttpError(HTTP_STATUS.BAD_REQUEST.withMessage(`${field} must be a date YYYY-MM-DD`));
  }
  return start;
}

/** Calendar days in UTC+7, `to` inclusive; defaults to the last 30 days (spec 015 R8). */
export function parseRange(from: string | undefined, to: string | undefined, now: Date): ReportRange {
  const toDay = to ?? vnDate(now);
  const end = new Date(parseDay(toDay, "to").getTime() + DAY_MS - 1);
  const fromDay = from ?? vnDate(new Date(end.getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_MS));
  const start = parseDay(fromDay, "from");
  if (start > end) {
    throw new HttpError(HTTP_STATUS.BAD_REQUEST.withMessage("from must not be after to"));
  }
  return { from: fromDay, to: toDay, start, end };
}

export type SourceReportRow = {
  received: number;
  delivered: number;
  holding: number;
  shrinkage: Record<GiftStockAdjustReason, number>;
  expired: number;
  inStock: number;
  valueDeliveredVnd: number;
  recipients: number;
};

export type SourceReport = {
  sourceId: string;
  from: string;
  to: string;
  totals: SourceReportRow;
  gifts: Array<SourceReportRow & { giftId: string; giftName: string }>;
};

export type ReportInput = {
  sourceId: string;
  range: ReportRange;
  now: Date;
  batches: Array<{
    id: string;
    giftId: string;
    giftName: string;
    quantity: number;
    remaining: number;
    unitValueVnd: number;
    receivedAt: Date;
    expiresAt: Date | null;
  }>;
  /** Items of orders DELIVERED within the range, per batch they came from (spec 018: items, not orders). */
  delivered: Array<{ batchId: string; userId: string; quantity: number }>;
  /** Items of orders currently PROCESSING or SHIPPED, per batch they came from. */
  holding: Array<{ batchId: string; quantity: number }>;
  /** ADJUST_OUT and EXPIRED movements within the range on this source's batches. */
  writeOffs: Array<{ batchId: string; type: "ADJUST_OUT" | "EXPIRED"; reason: GiftStockAdjustReason | null; quantity: number }>;
};

const emptyRow = (): SourceReportRow => ({
  received: 0,
  delivered: 0,
  holding: 0,
  shrinkage: { DAMAGED: 0, LOST: 0, COUNT_SHORTAGE: 0, RETURN_TO_SOURCE: 0 },
  expired: 0,
  inStock: 0,
  valueDeliveredVnd: 0,
  recipients: 0,
});

/** Pure aggregation of a source's report; the queries only fetch raw rows. */
export function buildSourceReport(input: ReportInput): SourceReport {
  const { range, now } = input;
  const batchById = new Map(input.batches.map((b) => [b.id, b]));
  const rows = new Map<string, SourceReportRow & { giftId: string; giftName: string }>();
  const rowFor = (batchId: string) => {
    const b = batchById.get(batchId);
    if (!b) return null;
    let row = rows.get(b.giftId);
    if (!row) {
      row = { giftId: b.giftId, giftName: b.giftName, ...emptyRow() };
      rows.set(b.giftId, row);
    }
    return { row, batch: b };
  };
  const recipientsByGift = new Map<string, Set<string>>();
  const allRecipients = new Set<string>();

  for (const b of input.batches) {
    const hit = rowFor(b.id)!;
    if (b.receivedAt >= range.start && b.receivedAt <= range.end) hit.row.received += b.quantity;
    if (isLive(b, now)) hit.row.inStock += b.remaining;
  }
  for (const d of input.delivered) {
    const hit = rowFor(d.batchId);
    if (!hit) continue;
    hit.row.delivered += d.quantity;
    hit.row.valueDeliveredVnd += hit.batch.unitValueVnd * d.quantity;
    const set = recipientsByGift.get(hit.batch.giftId) ?? new Set<string>();
    set.add(d.userId);
    recipientsByGift.set(hit.batch.giftId, set);
    allRecipients.add(d.userId);
  }
  for (const h of input.holding) {
    const hit = rowFor(h.batchId);
    if (hit) hit.row.holding += h.quantity;
  }
  for (const w of input.writeOffs) {
    const hit = rowFor(w.batchId);
    if (!hit) continue;
    const qty = Math.abs(w.quantity);
    if (w.type === "EXPIRED") hit.row.expired += qty;
    else if (w.reason) hit.row.shrinkage[w.reason] += qty;
  }

  const gifts = [...rows.values()]
    .map((r) => ({ ...r, recipients: recipientsByGift.get(r.giftId)?.size ?? 0 }))
    .sort((a, b) => a.giftName.localeCompare(b.giftName));
  const totals = emptyRow();
  for (const g of gifts) {
    totals.received += g.received;
    totals.delivered += g.delivered;
    totals.holding += g.holding;
    totals.expired += g.expired;
    totals.inStock += g.inStock;
    totals.valueDeliveredVnd += g.valueDeliveredVnd;
    for (const k of Object.keys(totals.shrinkage) as GiftStockAdjustReason[]) {
      totals.shrinkage[k] += g.shrinkage[k];
    }
  }
  totals.recipients = allRecipients.size;
  return { sourceId: input.sourceId, from: range.from, to: range.to, totals, gifts };
}

const CSV_HEADER = [
  "gift",
  "received",
  "delivered",
  "holding",
  "damaged",
  "lost",
  "count_shortage",
  "return_to_source",
  "expired",
  "in_stock",
  "value_delivered_vnd",
  "recipients",
];

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const csvLine = (name: string, r: SourceReportRow) =>
  [
    name,
    r.received,
    r.delivered,
    r.holding,
    r.shrinkage.DAMAGED,
    r.shrinkage.LOST,
    r.shrinkage.COUNT_SHORTAGE,
    r.shrinkage.RETURN_TO_SOURCE,
    r.expired,
    r.inStock,
    r.valueDeliveredVnd,
    r.recipients,
  ]
    .map(csvCell)
    .join(",");

/** UTF-8 with BOM so Excel shows Vietnamese correctly; totals first, then one line per gift. */
export function toCsv(report: SourceReport): string {
  const lines = [CSV_HEADER.join(","), csvLine("TOTAL", report.totals)];
  for (const g of report.gifts) lines.push(csvLine(g.giftName, g));
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** Loads the raw rows for one source and range, then aggregates them. */
export async function loadSourceReport(sourceId: string, range: ReportRange, now: Date): Promise<SourceReport> {
  const source = await prisma.giftSource.findUnique({ where: { id: sourceId }, select: { id: true } });
  if (!source) throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Gift source not found"));

  const batchRows = await prisma.giftStockBatch.findMany({
    where: { sourceId },
    include: { gift: { select: { name: true, nameVi: true } } },
  });
  const batchIds = batchRows.map((b) => b.id);
  const [taken, writeOffs] = await Promise.all([
    // What each order took from each batch; one order may span several batches (spec 018 R5).
    prisma.giftStockMovement.findMany({
      where: {
        batchId: { in: batchIds },
        type: "REDEEM_OUT",
        redemption: {
          OR: [
            { status: "DELIVERED", statusUpdatedAt: { gte: range.start, lte: range.end } },
            { status: { in: ["PROCESSING", "SHIPPED"] } },
          ],
        },
      },
      select: { batchId: true, quantity: true, redemption: { select: { status: true, userId: true } } },
    }),
    prisma.giftStockMovement.findMany({
      where: {
        batchId: { in: batchIds },
        type: { in: ["ADJUST_OUT", "EXPIRED"] },
        createdAt: { gte: range.start, lte: range.end },
      },
      select: { batchId: true, type: true, reason: true, quantity: true },
    }),
  ]);

  return buildSourceReport({
    sourceId,
    range,
    now,
    batches: batchRows.map((b) => ({
      id: b.id,
      giftId: b.giftId,
      giftName: b.gift.nameVi ?? b.gift.name,
      quantity: b.quantity,
      remaining: b.remaining,
      unitValueVnd: b.unitValueVnd,
      receivedAt: b.receivedAt,
      expiresAt: b.expiresAt,
    })),
    delivered: taken
      .filter((t) => t.redemption?.status === "DELIVERED")
      .map((t) => ({ batchId: t.batchId, userId: t.redemption!.userId, quantity: -t.quantity })),
    holding: taken
      .filter((t) => t.redemption && t.redemption.status !== "DELIVERED")
      .map((t) => ({ batchId: t.batchId, quantity: -t.quantity })),
    writeOffs: writeOffs.map((w) => ({
      batchId: w.batchId,
      type: w.type as "ADJUST_OUT" | "EXPIRED",
      reason: w.reason,
      quantity: w.quantity,
    })),
  });
}
