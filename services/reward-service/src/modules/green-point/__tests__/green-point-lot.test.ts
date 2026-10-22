import type { Prisma } from "@prisma/client";
import { planRefund, spendLotsFifo } from "../green-point-lot.util";

const NOW = new Date("2026-11-01T00:00:00.000Z");
const day = (d: number) => new Date(NOW.getTime() + d * 24 * 60 * 60 * 1000);

type Lot = { id: string; remaining: number; expiresAt: Date; createdAt: Date };

/** Lots already in FIFO order (the query sorts them); `stolen` lots fail their conditional update. */
function mockTx(lots: Lot[], stolen: string[] = []) {
  const spends: Array<{ lotId: string; amount: number }> = [];
  const tx = {
    greenPointLot: {
      findMany: jest.fn(async () => lots),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string }; data: { remaining: { decrement: number } } }) => {
        if (stolen.includes(where.id)) return { count: 0 };
        lots.find((l) => l.id === where.id)!.remaining -= data.remaining.decrement;
        return { count: 1 };
      }),
    },
    greenPointLotSpend: { create: jest.fn(async ({ data }: { data: { lotId: string; amount: number } }) => spends.push(data)) },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, spends };
}

const designLots = (): Lot[] => [
  { id: "old10", remaining: 10, expiresAt: day(2), createdAt: day(-80) },
  { id: "vote5", remaining: 5, expiresAt: day(80), createdAt: day(-10) },
  { id: "vote10", remaining: 10, expiresAt: day(80), createdAt: day(-10) },
  { id: "vote15", remaining: 15, expiresAt: day(80), createdAt: day(-10) },
  { id: "camp40", remaining: 40, expiresAt: day(85), createdAt: day(-5) },
];

describe("spendLotsFifo", () => {
  it("takes 72 as 10, 5, 10, 15, 32 (the design example) and records each take", async () => {
    const lots = designLots();
    const { tx, spends } = mockTx(lots);
    await spendLotsFifo(tx, "an", "red1", 72, NOW);
    expect(spends).toEqual([
      { redemptionId: "red1", lotId: "old10", amount: 10 },
      { redemptionId: "red1", lotId: "vote5", amount: 5 },
      { redemptionId: "red1", lotId: "vote10", amount: 10 },
      { redemptionId: "red1", lotId: "vote15", amount: 15 },
      { redemptionId: "red1", lotId: "camp40", amount: 32 },
    ]);
    expect(lots.map((l) => l.remaining)).toEqual([0, 0, 0, 0, 8]);
  });

  it("refuses when a lot was taken by another request meanwhile", async () => {
    const { tx } = mockTx(designLots(), ["vote10"]);
    await expect(spendLotsFifo(tx, "an", "red1", 72, NOW)).rejects.toThrow("Insufficient green points");
  });

  it("refuses when live lots do not cover the price", async () => {
    const { tx } = mockTx(designLots());
    await expect(spendLotsFifo(tx, "an", "red1", 81, NOW)).rejects.toThrow("Insufficient green points");
  });
});

describe("planRefund", () => {
  it("gives live lots back and writes off lots expired by now (expiry instant counts as expired)", () => {
    const spends = [
      { lotId: "old10", amount: 10 },
      { lotId: "edge", amount: 3 },
      { lotId: "camp40", amount: 32 },
    ];
    const expiresAt = new Map([
      ["old10", day(-1)],
      ["edge", NOW],
      ["camp40", day(85)],
    ]);
    expect(planRefund(spends, expiresAt, NOW)).toEqual({
      restore: [{ lotId: "camp40", amount: 32 }],
      expire: [
        { lotId: "old10", amount: 10 },
        { lotId: "edge", amount: 3 },
      ],
    });
  });
});
