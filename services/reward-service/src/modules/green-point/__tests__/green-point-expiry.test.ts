import type { PrismaClient } from "@prisma/client";

jest.mock("../../../config/prisma.client", () => ({ __esModule: true, default: {} }));

import { expireDueLots } from "../green-point-expiry.job";

type Lot = { id: string; userId: string; remaining: number; expiresAt: Date };

const NOW = new Date("2026-11-10T00:00:00.000Z");
const lot = (id: string, remaining: number): Lot => ({
  id,
  userId: "u1",
  remaining,
  expiresAt: new Date("2026-11-05T00:00:00.000Z"),
});

/** In-memory lots and ledger; `contended` lots fail their conditional update once. */
function mockDb(lots: Lot[], opts: { written?: string[]; contended?: string[] } = {}) {
  const ledger: Array<{ idempotencyKey: string; points: number }> = [];
  const keys = new Set(opts.written ?? []);
  const contended = new Set(opts.contended ?? []);
  const updateMany = jest.fn(async ({ where }: { where: { id: string } }) => {
    if (contended.has(where.id)) return { count: 0 };
    const l = lots.find((x) => x.id === where.id)!;
    l.remaining = 0;
    return { count: 1 };
  });
  const tx = {
    greenPointTransaction: {
      createMany: jest.fn(async ({ data }: { data: Array<{ idempotencyKey: string; points: number }> }) => {
        if (keys.has(data[0].idempotencyKey)) return { count: 0 };
        keys.add(data[0].idempotencyKey);
        ledger.push(data[0]);
        return { count: 1 };
      }),
    },
    greenPointLot: { updateMany },
  };
  const db = {
    greenPointLot: {
      // Ordered by id (same expiry); honours the cursor's id > last.id branch.
      findMany: jest.fn(async ({ where, take }: { where: { AND: Array<{ OR: Array<{ id?: { gt: string } }> }> }; take: number }) => {
        const afterId = where.AND[0]?.OR[1]?.id?.gt;
        return lots
          .filter((l) => l.remaining > 0 && (!afterId || l.id > afterId))
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, take);
      }),
    },
    // Rolls back by snapshotting the ledger and keys when the callback throws.
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      const ledgerLen = ledger.length;
      const keySnapshot = new Set(keys);
      try {
        return await fn(tx);
      } catch (e) {
        ledger.length = ledgerLen;
        keys.clear();
        keySnapshot.forEach((k) => keys.add(k));
        throw e;
      }
    }),
  };
  return { db: db as unknown as PrismaClient, ledger, updateMany };
}

describe("expireDueLots", () => {
  beforeEach(() => jest.spyOn(console, "error").mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it("writes one negative EXPIRE row per lot and empties it", async () => {
    const lots = [lot("a", 10), lot("b", 6)];
    const { db, ledger } = mockDb(lots);
    expect(await expireDueLots(NOW, 200, db)).toEqual({ expired: 2, failed: 0 });
    expect(ledger).toEqual([
      expect.objectContaining({ idempotencyKey: "expire:a", points: -10, type: "EXPIRE", resourceType: "GREEN_POINT_LOT" }),
      expect.objectContaining({ idempotencyKey: "expire:b", points: -6 }),
    ]);
    expect(lots.map((l) => l.remaining)).toEqual([0, 0]);
  });

  it("skips a lot whose EXPIRE row already exists without touching it", async () => {
    const lots = [lot("a", 10)];
    const { db, ledger, updateMany } = mockDb(lots, { written: ["expire:a"] });
    expect(await expireDueLots(NOW, 200, db)).toEqual({ expired: 0, failed: 0 });
    expect(ledger).toHaveLength(0);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("rolls back a lot changed meanwhile, goes on with the next and does not retry it in this run", async () => {
    const lots = [lot("a", 10), lot("b", 6)];
    const { db, ledger } = mockDb(lots, { contended: ["a"] });
    expect(await expireDueLots(NOW, 1, db)).toEqual({ expired: 1, failed: 1 });
    expect(ledger.map((r) => r.idempotencyKey)).toEqual(["expire:b"]);
    expect(lots[0].remaining).toBe(10);
  });
});
