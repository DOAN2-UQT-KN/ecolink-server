import type { Prisma } from "@prisma/client";
import {
  adjustBatch,
  batchState,
  returnToBatches,
  takeFromBatches,
  toRedemptionSources,
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

/** In-memory stand-in for the tables the stock helpers touch; `stolen` batches are drained by another request. */
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
          if (stolen.includes(b.id)) b.remaining = 0;
          if (b.remaining < min) return { count: 0 };
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
        const dup = movements.some(
          (m) => row.redemptionId && m.redemptionId === row.redemptionId && m.batchId === (row as { batchId?: string }).batchId && m.type === row.type,
        );
        if (dup) return { count: 0 };
        movements.push(row);
        return { count: 1 };
      }),
      findMany: jest.fn(async ({ where }: { where: { redemptionId: string; type: string } }) =>
        movements.filter((m) => m.redemptionId === where.redemptionId && m.type === where.type),
      ),
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

describe("takeFromBatches", () => {
  it("asks for earliest expiry first, no-expiry batches last, then earliest received", async () => {
    const { tx, raw } = mockTx([{ id: "a", giftId: "g", quantity: 2, remaining: 2, expiresAt: day(3), receivedAt: day(-1) }]);
    await takeFromBatches(tx, "g", "r1", "u1", 1, NOW);
    const args = (raw.giftStockBatch.findMany.mock.calls[0] as unknown[])[0] as { orderBy: unknown };
    expect(args.orderBy).toEqual([
      { expiresAt: { sort: "asc", nulls: "last" } },
      { receivedAt: "asc" },
      { id: "asc" },
    ]);
  });

  it("takes all items from one batch with one REDEEM_OUT by the user and one cache change", async () => {
    const batches = [{ id: "a", giftId: "g", quantity: 5, remaining: 5, expiresAt: day(3), receivedAt: day(-1) }];
    const { tx, raw, movements, cache } = mockTx(batches);
    await expect(takeFromBatches(tx, "g", "r1", "u1", 3, NOW)).resolves.toEqual([{ batchId: "a", quantity: 3 }]);
    expect(batches[0].remaining).toBe(2);
    expect(movements).toEqual([expect.objectContaining({ type: "REDEEM_OUT", quantity: -3, redemptionId: "r1", actorId: "u1" })]);
    expect(cache.delta).toBe(-3);
    expect(raw.gift.update).toHaveBeenCalledTimes(1);
  });

  it("spreads the items across batches in order, one movement per batch", async () => {
    const batches = [
      { id: "a", giftId: "g", quantity: 2, remaining: 2, expiresAt: day(3), receivedAt: day(-1) },
      { id: "b", giftId: "g", quantity: 8, remaining: 8, expiresAt: null, receivedAt: day(-2) },
    ];
    const { tx, movements, cache } = mockTx(batches);
    await expect(takeFromBatches(tx, "g", "r1", "u1", 3, NOW)).resolves.toEqual([
      { batchId: "a", quantity: 2 },
      { batchId: "b", quantity: 1 },
    ]);
    expect(batches.map((b) => b.remaining)).toEqual([0, 7]);
    expect(movements.map((m) => [m.batchId, m.quantity])).toEqual([["a", -2], ["b", -1]]);
    expect(cache.delta).toBe(-3);
  });

  it("re-reads a batch drained by another request and moves on", async () => {
    const batches = [
      { id: "a", giftId: "g", quantity: 1, remaining: 1, expiresAt: day(3), receivedAt: day(-1) },
      { id: "b", giftId: "g", quantity: 5, remaining: 5, expiresAt: null, receivedAt: day(-2) },
    ];
    const { tx } = mockTx(batches, ["a"]);
    await expect(takeFromBatches(tx, "g", "r1", "u1", 2, NOW)).resolves.toEqual([{ batchId: "b", quantity: 2 }]);
    expect(batches[1].remaining).toBe(3);
  });

  it("takes what is left of a batch that shrank meanwhile", async () => {
    const batches = [
      { id: "a", giftId: "g", quantity: 5, remaining: 5, expiresAt: day(3), receivedAt: day(-1) },
      { id: "b", giftId: "g", quantity: 5, remaining: 5, expiresAt: null, receivedAt: day(-2) },
    ];
    const { tx, raw } = mockTx(batches);
    // Another order takes 3 of batch "a" between the read and the update.
    raw.giftStockBatch.findMany.mockImplementationOnce(async () => {
      const read = batches.map((b) => ({ ...b }));
      batches[0].remaining = 2;
      return read;
    });
    await expect(takeFromBatches(tx, "g", "r1", "u1", 4, NOW)).resolves.toEqual([
      { batchId: "a", quantity: 2 },
      { batchId: "b", quantity: 2 },
    ]);
  });

  it("refuses with not enough stock when some but too few items are left", async () => {
    const { tx, cache } = mockTx([{ id: "a", giftId: "g", quantity: 2, remaining: 2, expiresAt: null, receivedAt: day(-1) }]);
    await expect(takeFromBatches(tx, "g", "r1", "u1", 3, NOW)).rejects.toThrow("Not enough stock");
    expect(cache.delta).toBe(0);
  });

  it("refuses with out of stock when no batch can give an item", async () => {
    const { tx, movements, cache } = mockTx([{ id: "a", giftId: "g", quantity: 1, remaining: 1, expiresAt: null, receivedAt: day(-1) }], ["a"]);
    await expect(takeFromBatches(tx, "g", "r1", "u1", 1, NOW)).rejects.toThrow("Gift is out of stock");
    expect(movements).toHaveLength(0);
    expect(cache.delta).toBe(0);
  });
});

describe("returnToBatches", () => {
  const twoBatches = () => [
    { id: "a", giftId: "g", quantity: 2, remaining: 2, expiresAt: day(3), receivedAt: day(-1) },
    { id: "b", giftId: "g", quantity: 8, remaining: 8, expiresAt: null, receivedAt: day(-2) },
  ];

  it("puts each batch's items back once, even when called twice", async () => {
    const batches = twoBatches();
    const { tx, movements, cache } = mockTx(batches);
    await takeFromBatches(tx, "g", "r1", "u1", 3, NOW);
    const red = { id: "r1", giftId: "g" };
    await expect(returnToBatches(tx, red, "admin", NOW)).resolves.toBe(3);
    await expect(returnToBatches(tx, red, "admin", NOW)).resolves.toBe(0);
    expect(batches.map((b) => b.remaining)).toEqual([2, 8]);
    expect(movements.filter((m) => m.type === "CANCEL_RETURN").map((m) => [m.batchId, m.quantity])).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
    expect(cache.delta).toBe(0);
  });

  it("returns into an expired batch without raising the cache", async () => {
    const batches = [{ id: "a", giftId: "g", quantity: 2, remaining: 1, expiresAt: day(3), receivedAt: day(-5) }];
    const { tx, cache } = mockTx(batches);
    await takeFromBatches(tx, "g", "r1", "u1", 1, NOW);
    batches[0].expiresAt = day(-1);
    await returnToBatches(tx, { id: "r1", giftId: "g" }, "admin", NOW);
    expect(batches[0].remaining).toBe(1);
    expect(cache.delta).toBe(-1);
  });

  it("does nothing for an order that never took from a batch", async () => {
    const { tx, movements } = mockTx([]);
    await expect(returnToBatches(tx, { id: "r1", giftId: "g" }, "admin", NOW)).resolves.toBe(0);
    expect(movements).toHaveLength(0);
  });
});

describe("toRedemptionSources", () => {
  const out = (quantity: number, id: string) => ({ quantity, batch: { source: { id, name: `Source ${id}` } } });

  it("is empty for an order without movements", () => {
    expect(toRedemptionSources([])).toEqual([]);
  });

  it("adds up items per source in the order taken", () => {
    expect(toRedemptionSources([out(-2, "s2"), out(-1, "s1"), out(-1, "s2")])).toEqual([
      { id: "s2", name: "Source s2", quantity: 3 },
      { id: "s1", name: "Source s1", quantity: 1 },
    ]);
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
