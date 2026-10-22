import type { PrismaClient } from "@prisma/client";

jest.mock("../../../config/prisma.client", () => ({ __esModule: true, default: {} }));

import { expireDueBatches } from "../gift-stock-expiry.job";

type Batch = { id: string; giftId: string; remaining: number; expiresAt: Date };

const NOW = new Date("2026-11-10T00:00:00.000Z");
const batch = (id: string, remaining: number): Batch => ({
  id,
  giftId: "g1",
  remaining,
  expiresAt: new Date("2026-11-05T00:00:00.000Z"),
});

/** In-memory batches; `failing` batches throw inside their transaction. */
function mockDb(batches: Batch[], failing: string[] = []) {
  const movements: Array<{ batchId: string; quantity: number }> = [];
  const tx = {
    giftStockBatch: {
      updateMany: jest.fn(async ({ where }: { where: { id: string; remaining: number } }) => {
        if (failing.includes(where.id)) throw new Error("boom");
        const b = batches.find((x) => x.id === where.id)!;
        if (b.remaining !== where.remaining) return { count: 0 };
        b.remaining = 0;
        return { count: 1 };
      }),
    },
    giftStockMovement: {
      create: jest.fn(async ({ data }: { data: { batchId: string; quantity: number } }) => movements.push(data)),
    },
  };
  const findMany = jest.fn(
    async ({ where, take }: { where: { AND: Array<{ OR: Array<{ id?: { gt: string } }> }> }; take: number }) => {
      const after = where.AND[0]?.OR[1]?.id?.gt;
      return batches
        .filter((b) => b.remaining > 0 && b.expiresAt <= NOW)
        .filter((b) => (after ? b.id > after : true))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, take)
        .map((b) => ({ ...b })); // the DB hands out copies, not live rows
    },
  );
  const db = {
    giftStockBatch: { findMany },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { db: db as unknown as PrismaClient, movements, findMany };
}

describe("expireDueBatches", () => {
  it("writes an EXPIRED movement for what is left and empties the batch", async () => {
    const batches = [batch("a", 3)];
    const { db, movements } = mockDb(batches);
    await expect(expireDueBatches(NOW, 200, db)).resolves.toEqual({ expired: 1, failed: 0 });
    expect(batches[0].remaining).toBe(0);
    expect(movements).toEqual([expect.objectContaining({ batchId: "a", quantity: -3, type: "EXPIRED" })]);
  });

  it("writes nothing on a second run", async () => {
    const batches = [batch("a", 3)];
    const { db, movements } = mockDb(batches);
    await expireDueBatches(NOW, 200, db);
    await expect(expireDueBatches(NOW, 200, db)).resolves.toEqual({ expired: 0, failed: 0 });
    expect(movements).toHaveLength(1);
  });

  it("keeps going when one batch fails", async () => {
    const batches = [batch("a", 1), batch("b", 2), batch("c", 3)];
    const { db, movements } = mockDb(batches, ["b"]);
    await expect(expireDueBatches(NOW, 200, db)).resolves.toEqual({ expired: 2, failed: 1 });
    expect(movements.map((m) => m.batchId)).toEqual(["a", "c"]);
  });

  it("does not revisit a failed batch within the same run", async () => {
    const batches = [batch("a", 1), batch("b", 2), batch("c", 3)];
    const { db, findMany } = mockDb(batches, ["a"]);
    await expireDueBatches(NOW, 1, db);
    // pages: a (fails), b, c, then an empty page
    expect(findMany).toHaveBeenCalledTimes(4);
  });
});
