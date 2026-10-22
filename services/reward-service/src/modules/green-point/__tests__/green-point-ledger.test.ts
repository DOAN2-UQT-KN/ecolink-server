import type { Prisma } from "@prisma/client";
import { applyResolvedCredits, creditPoints } from "../green-point-ledger.util";
import { IdempotencyKey } from "../green-point-transaction.constants";
import type { ResolvedCredit } from "../strategies/green-point-credit-strategy.types";

const NOW = new Date("2026-11-01T00:00:00.000Z");

/** Ledger keys already written; createMany behaves like INSERT … ON CONFLICT DO NOTHING. */
function mockTx(existingKeys: string[] = []) {
  const keys = new Set(existingKeys);
  const lots: Array<Record<string, unknown>> = [];
  const tx = {
    greenPointTransaction: {
      createMany: jest.fn(async ({ data }: { data: Array<{ userId: string; idempotencyKey: string }> }) => {
        const key = `${data[0].userId}|${data[0].idempotencyKey}`;
        if (keys.has(key)) return { count: 0 };
        keys.add(key);
        return { count: 1 };
      }),
    },
    greenPointLot: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => lots.push(data)) },
    gamificationPointRules: {
      findFirst: jest.fn(async () => ({
        id: "rule-1",
        campaignCompletionPoints: 20,
        baseReportPoint: 5,
        reportMilestoneThresholds: [],
        reportCompletionPoints: 0,
        pointExpirationDays: 30,
      })),
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, lots };
}

const row = (points: number) => ({
  userId: "u1",
  points,
  type: "CAMPAIGN_COMPLETION",
  resourceId: "c1",
  resourceType: "CAMPAIGN",
  idempotencyKey: IdempotencyKey.campaignCompletion("c1"),
});

describe("creditPoints", () => {
  it("skips amounts <= 0 without writing", async () => {
    const { tx, lots } = mockTx();
    expect(await creditPoints(tx, row(0), 90, NOW)).toBe("skipped");
    expect(lots).toHaveLength(0);
  });

  it("writes one ledger row and one lot expiring after the given days", async () => {
    const { tx, lots } = mockTx();
    expect(await creditPoints(tx, row(40), 90, NOW)).toBe("credited");
    expect(lots).toEqual([
      expect.objectContaining({
        userId: "u1",
        amount: 40,
        remaining: 40,
        transactionId: expect.any(String),
        expiresAt: new Date("2027-01-30T00:00:00.000Z"),
      }),
    ]);
  });

  it("skips a key already in the ledger and creates no lot", async () => {
    const { tx, lots } = mockTx(["u1|campaign_completion:c1"]);
    expect(await creditPoints(tx, row(40), 90, NOW)).toBe("skipped");
    expect(lots).toHaveLength(0);
  });
});

describe("applyResolvedCredits", () => {
  const credit = (userId: string): ResolvedCredit => ({
    userId,
    points: 20,
    transactionType: "CAMPAIGN_COMPLETION",
    resourceId: "c1",
    resourceType: "CAMPAIGN",
    idempotencyKey: IdempotencyKey.campaignCompletion("c1"),
    metadata: {},
  });

  it("still credits later users when an earlier one is a duplicate", async () => {
    const { tx, lots } = mockTx(["u1|campaign_completion:c1"]);
    expect(await applyResolvedCredits(tx, [credit("u1"), credit("u2")])).toEqual({ credited: 1, skipped: 1 });
    expect(lots).toEqual([expect.objectContaining({ userId: "u2" })]);
  });

  it("uses the expiry days from the point rules", async () => {
    const { tx, lots } = mockTx();
    await applyResolvedCredits(tx, [credit("u1")]);
    const lot = lots[0] as { createdAt: Date; expiresAt: Date };
    expect(lot.expiresAt.getTime() - lot.createdAt.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe("IdempotencyKey", () => {
  it("matches the step-2 key scheme", () => {
    expect(IdempotencyKey.voteMilestone("r1", 5)).toBe("vote_milestone:r1:5");
    expect(IdempotencyKey.reportCompletion("r1")).toBe("report_completion:r1");
    expect(IdempotencyKey.giftRedeem("g1")).toBe("gift_redeem:g1");
    expect(IdempotencyKey.giftRedeemRefund("g1")).toBe("gift_redeem_refund:g1");
    expect(IdempotencyKey.expire("l1")).toBe("expire:l1");
    expect(IdempotencyKey.expireOnRefund("l1", "g1")).toBe("expire:l1:g1");
    expect(IdempotencyKey.migrationAdjust("u1")).toBe("migration_adjust:u1");
  });
});
