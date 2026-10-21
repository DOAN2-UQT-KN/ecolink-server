import type { Prisma } from "@prisma/client";
import {
  adjustBatch,
  batchState,
  returnToBatch,
  takeOneFromBatches,
} from "../gift-stock.util";

const NOW = new Date("2026-11-01T00:00:00.000Z");
const day = (d: number) => new Date(NOW.getTime() + d * 24 * 60 * 60 * 1000);

type Batch = {
  id: string;
  giftId: string;
  quantity: number;
  remaining: number;
  expiresAt: Date | null;
  receivedAt: Date;
};

/** In-memory stand-in for the tables the stock helpers touch; `stolen` batches fail their conditional update. */
function mockTx(batches: Batch[], stolen: string[] = []) {
  const movements: Array<Record<string, unknown>> = [];
  const cache = { delta: 0 };
  const tx = {
    giftStockBatch: {
      findMany: jest.fn(async () => batches.filter((b) => b.remaining > 0 && (!b.expiresAt || b.expiresAt > NOW))),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => batches.find((b) => b.id === where.id) ?? null),
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { id: string } }) => batches.find((b) => b.id === where.id)),
      updateMany: jest.fn(
        async ({ where, data }: { where: { id: string; remaining: { gt?: number; gte?: number } }; data: { remaining: { decrement: number } } }) => {
          const b = batches.find((x) => x.id === where.id)!;
          const min = where.remaining.gte ?? (where.remaining.gt ?? 0) + 1;
          if (stolen.includes(b.id) || b.remaining < min) return { count: 0 };
          b.remaining -= data.remaining.decrement;
          return { count: 1 };
        },
      ),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: { remaining: { increment: number } } }) => {
        const b = batches.find((x) => x.id === where.id)!;
        b.remaining += data.remaining.increment;
        return b;
      }),
    },
    giftStockMovement: {
      createMany: jest.fn(async ({ data }: { data: Array<{ redemptionId?: string; type: string }> }) => {
        const row = data[0];
        const dup = movements.some((m) => row.redemptionId && m.redemptionId === row.redemptionId && m.type === row.type);
        if (dup) return { count: 0 };
        movements.push(row);
        return { count: 1 };
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        movements.push(data);
        return data;
      }),
    },
    gift: {
      update: jest.fn(async ({ data }: { data: { stockRemaining: { increment: number } } }) => {
        cache.delta += data.stockRemaining.increment;
      }),
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, raw: tx, movements, cache };
}

describe("takeOneFromBatches", () => {
  it("asks for earliest expiry first, no-expiry batches last, then earliest received", async () => {
    const { tx, raw } = mockTx([{ id: "a", giftId: "g", quantity: 2, remaining: 2, expiresAt: day(3), receivedAt: day(-1) }]);
    await takeOneFromBatches(tx, "g", "r1", "u1", NOW);
    expect(raw.giftStockBatch.findMany.mock.calls[0]).toBeDefined();
    const args = (raw.giftStockBatch.findMany.mock.calls[0] as unknown[])[0] as { orderBy: unknown };
    expect(args.orderBy).toEqual([
      { expiresAt: { sort: "asc", nulls: "last" } },
      { receivedAt: "asc" },
      { id: "asc" },
    ]);
  });

  it("takes one, records REDEEM_OUT by the user and lowers the cache", async () => {
    const batches = [{ id: "a", giftId: "g", quantity: 2, remaining: 2, expiresAt: day(3), receivedAt: day(-1) }];
    const { tx, movements, cache } = mockTx(batches);
    await expect(takeOneFromBatches(tx, "g", "r1", "u1", NOW)).resolves.toBe("a");
    expect(batches[0].remaining).toBe(1);
    expect(movements).toEqual([expect.objectContaining({ type: "REDEEM_OUT", quantity: -1, redemptionId: "r1", actorId: "u1" })]);
    expect(cache.delta).toBe(-1);
  });

  it("moves to the next batch when the first was emptied by another request", async () => {
    const batches = [
      { id: "a", giftId: "g", quantity: 1, remaining: 1, expiresAt: day(3), receivedAt: day(-1) },
      { id: "b", giftId: "g", quantity: 5, remaining: 5, expiresAt: null, receivedAt: day(-2) },
    ];
    const { tx } = mockTx(batches, ["a"]);
    await expect(takeOneFromBatches(tx, "g", "r1", "u1", NOW)).resolves.toBe("b");
    expect(batches[1].remaining).toBe(4);
  });

  it("refuses with out of stock when no batch can give an item", async () => {
    const { tx, movements, cache } = mockTx([{ id: "a", giftId: "g", quantity: 1, remaining: 1, expiresAt: null, receivedAt: day(-1) }], ["a"]);
    await expect(takeOneFromBatches(tx, "g", "r1", "u1", NOW)).rejects.toThrow("Gift is out of stock");
    expect(movements).toHaveLength(0);
    expect(cache.delta).toBe(0);
  });
});

describe("returnToBatch", () => {
  it("returns the item once even when called twice", async () => {
    const batches = [{ id: "a", giftId: "g", quantity: 2, remaining: 1, expiresAt: day(3), receivedAt: day(-1) }];
    const { tx, movements, cache } = mockTx(batches);
    const red = { id: "r1", giftId: "g", batchId: "a" };
    await expect(returnToBatch(tx, red, "admin", NOW)).resolves.toBe(true);
    await expect(returnToBatch(tx, red, "admin", NOW)).resolves.toBe(false);
    expect(batches[0].remaining).toBe(2);
    expect(movements.filter((m) => m.type === "CANCEL_RETURN")).toHaveLength(1);
    expect(cache.delta).toBe(1);
  });

  it("returns into an expired batch without raising the cache", async () => {
    const batches = [{ id: "a", giftId: "g", quantity: 2, remaining: 0, expiresAt: day(-1), receivedAt: day(-5) }];
    const { tx, cache } = mockTx(batches);
    await returnToBatch(tx, { id: "r1", giftId: "g", batchId: "a" }, "admin", NOW);
    expect(batches[0].remaining).toBe(1);
    expect(cache.delta).toBe(0);
  });

  it("does nothing for an order without a batch", async () => {
    const { tx, movements } = mockTx([]);
    await expect(returnToBatch(tx, { id: "r1", giftId: "g", batchId: null }, "admin", NOW)).resolves.toBe(false);
    expect(movements).toHaveLength(0);
  });
});

describe("adjustBatch", () => {
  it("writes items off with a reason and lowers the cache", async () => {
    const batches = [{ id: "a", giftId: "g", quantity: 10, remaining: 10, expiresAt: null, receivedAt: day(-1) }];
    const { tx, movements, cache } = mockTx(batches);
    await adjustBatch(tx, "a", 1, "DAMAGED", null, "admin", NOW);
    expect(batches[0].remaining).toBe(9);
    expect(movements).toEqual([expect.objectContaining({ type: "ADJUST_OUT", quantity: -1, reason: "DAMAGED", actorId: "admin" })]);
    expect(cache.delta).toBe(-1);
  });

  it("refuses more than is left and writes nothing", async () => {
    const batches = [{ id: "a", giftId: "g", quantity: 10, remaining: 9, expiresAt: null, receivedAt: day(-1) }];
    const { tx, movements, cache } = mockTx(batches);
    await expect(adjustBatch(tx, "a", 20, "LOST", null, "admin", NOW)).rejects.toThrow("Not enough stock in batch");
    expect(batches[0].remaining).toBe(9);
    expect(movements).toHaveLength(0);
    expect(cache.delta).toBe(0);
  });

  it("does not touch the cache for an expired batch", async () => {
    const batches = [{ id: "a", giftId: "g", quantity: 3, remaining: 3, expiresAt: day(-1), receivedAt: day(-5) }];
    const { tx, cache } = mockTx(batches);
    await adjustBatch(tx, "a", 3, "COUNT_SHORTAGE", null, "admin", NOW);
    expect(cache.delta).toBe(0);
  });
});

describe("batchState", () => {
  it("covers the four states", () => {
    expect(batchState({ remaining: 3, expiresAt: day(-1) }, NOW)).toBe("EXPIRED");
    expect(batchState({ remaining: 0, expiresAt: null }, NOW)).toBe("OUT_OF_STOCK");
    expect(batchState({ remaining: 3, expiresAt: day(5) }, NOW)).toBe("EXPIRING_SOON");
    expect(batchState({ remaining: 3, expiresAt: day(30) }, NOW)).toBe("IN_STOCK");
    expect(batchState({ remaining: 3, expiresAt: null }, NOW)).toBe("IN_STOCK");
  });
});
