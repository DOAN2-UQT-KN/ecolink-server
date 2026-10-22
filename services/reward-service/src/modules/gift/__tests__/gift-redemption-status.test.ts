const mockTx = {
  $queryRaw: jest.fn(),
  giftRedemption: { findUnique: jest.fn(), update: jest.fn() },
  giftRedemptionEvent: { create: jest.fn() },
};

jest.mock("../../../config/prisma.client", () => ({
  __esModule: true,
  default: { $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(mockTx)) },
}));
jest.mock("../../../queue/green-point-queue.bootstrap", () => ({ backgroundJobDispatcher: { enqueue: jest.fn() } }));
jest.mock("../../../utils/identity-user.client", () => ({ fetchUsersByIds: jest.fn(), getUserProfile: jest.fn() }));
jest.mock("../gift-stock.util", () => ({
  EXPIRING_SOON_DAYS: 7,
  loadLiveBatchesForGifts: jest.fn(),
  REDEEM_SOURCES_INCLUDE: {},
  takeFromBatches: jest.fn(),
  toRedemptionSources: jest.fn(() => []),
  returnToBatches: jest.fn(async () => 1),
}));
jest.mock("../../green-point/green-point-lot.util", () => ({
  getBalance: jest.fn(),
  spendLotsFifo: jest.fn(),
  planRefund: jest.fn(() => ({ restore: [], expire: [] })),
}));
jest.mock("../../green-point/green-point-ledger.util", () => ({
  insertLedgerOnce: jest.fn(async () => null),
  loadPointExpirationDays: jest.fn(),
  lotExpiresAt: jest.fn(),
}));

import { insertLedgerOnce } from "../../green-point/green-point-ledger.util";
import { allowedTransitionsFor } from "../gift.dto";
import { returnToBatches } from "../gift-stock.util";
import { giftService } from "../gift.service";

const order = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  code: "EL-ABCDEFGH",
  carrier: null,
  trackingCode: null,
  shippedAt: null,
  userId: "u1",
  giftId: "g1",
  greenPointsSpent: 72,
  phoneNumber: "0900000000",
  pickupLocation: "HCM",
  status: "PROCESSING",
  statusUpdatedAt: new Date(),
  cancelledAt: null,
  createdAt: new Date(),
  batchId: "b1",
  cancelReason: null,
  restocked: null,
  ...over,
});

const fieldOf = (err: { data?: { errors?: Array<{ path: string }> } }) => err.data?.errors?.[0]?.path;

const SHIP = { status: "SHIPPED" as const, carrier: "GHN", trackingCode: "GHN123456" };
const events = () => mockTx.giftRedemptionEvent.create.mock.calls.map((c) => c[0].data);

beforeEach(() => {
  jest.clearAllMocks();
  mockTx.$queryRaw.mockResolvedValue([{ id: "r1" }]);
  mockTx.giftRedemption.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    order(data),
  );
});

describe("cancelling an order", () => {
  it("needs a reason", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(order());
    const err = await giftService.updateRedemptionStatus("r1", { status: "CANCELLED", cancelReason: "  " }).catch((e) => e);
    expect(err.statusResponse.status).toBe(400);
    expect(fieldOf(err)).toBe("cancelReason");
    expect(mockTx.giftRedemption.update).not.toHaveBeenCalled();
  });

  it("rejects a reason over 500 characters", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(order());
    const err = await giftService
      .updateRedemptionStatus("r1", { status: "CANCELLED", cancelReason: "x".repeat(501) })
      .catch((e) => e);
    expect(fieldOf(err)).toBe("cancelReason");
  });

  it("needs the restock choice for a SHIPPED order", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(order({ status: "SHIPPED" }));
    const err = await giftService
      .updateRedemptionStatus("r1", { status: "CANCELLED", cancelReason: "Lost in delivery" })
      .catch((e) => e);
    expect(fieldOf(err)).toBe("restock");
  });

  it("always restocks a PROCESSING order", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(order());
    const res = await giftService.updateRedemptionStatus(
      "r1",
      { status: "CANCELLED", cancelReason: " User changed mind ", restock: false },
      "admin",
    );
    expect(returnToBatches).toHaveBeenCalledTimes(1);
    expect(mockTx.giftRedemption.update).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: expect.objectContaining({ cancelReason: "User changed mind", restocked: true }),
    });
    expect(res?.redemption.allowedTransitions).toEqual([]);
    expect(events()).toEqual([
      expect.objectContaining({
        type: "CANCELLED",
        fromStatus: "PROCESSING",
        toStatus: "CANCELLED",
        actorRole: "ADMIN",
        actorId: "admin",
        data: { cancelReason: "User changed mind", restocked: true, returnedQuantity: 1 },
      }),
    ]);
  });

  it("restocks a SHIPPED order only when the item came back", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(order({ status: "SHIPPED" }));
    await giftService.updateRedemptionStatus("r1", { status: "CANCELLED", cancelReason: "Returned", restock: true });
    expect(returnToBatches).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    mockTx.giftRedemption.findUnique.mockResolvedValue(order({ status: "SHIPPED" }));
    await giftService.updateRedemptionStatus("r1", { status: "CANCELLED", cancelReason: "Lost", restock: false });
    expect(returnToBatches).not.toHaveBeenCalled();
    expect(mockTx.giftRedemption.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ restocked: false }) }),
    );
  });

  it("records restocked = false for an order that took from no batch", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(order({ batchId: null }));
    (returnToBatches as jest.Mock).mockResolvedValueOnce(0);
    await giftService.updateRedemptionStatus("r1", { status: "CANCELLED", cancelReason: "Old order" });
    expect(mockTx.giftRedemption.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ restocked: false }) }),
    );
  });

  it("changes nothing when the order is already cancelled", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(
      order({ status: "CANCELLED", cancelReason: "First", restocked: true }),
    );
    const res = await giftService.updateRedemptionStatus("r1", {
      status: "CANCELLED",
      cancelReason: "Second",
      restock: true,
    });
    expect(res?.redemption.cancelReason).toBe("First");
    expect(res?.changed).toBe(false);
    expect(events()).toEqual([]);
    expect(mockTx.giftRedemption.update).not.toHaveBeenCalled();
    expect(insertLedgerOnce).not.toHaveBeenCalled();
    expect(returnToBatches).not.toHaveBeenCalled();
  });

  it("locks the order row first", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(order());
    await giftService.updateRedemptionStatus("r1", SHIP);
    expect(mockTx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("returns null for an unknown order", async () => {
    mockTx.$queryRaw.mockResolvedValue([]);
    expect(await giftService.updateRedemptionStatus("r1", SHIP)).toBeNull();
  });
});

describe("shipping an order", () => {
  it("needs a carrier", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(order());
    const err = await giftService.updateRedemptionStatus("r1", { status: "SHIPPED", trackingCode: "A1" }).catch((e) => e);
    expect(err.statusResponse.status).toBe(400);
    expect(fieldOf(err)).toBe("carrier");
    expect(mockTx.giftRedemption.update).not.toHaveBeenCalled();
  });

  it("rejects a tracking code with spaces inside", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(order());
    const err = await giftService
      .updateRedemptionStatus("r1", { ...SHIP, trackingCode: "GHN 123" })
      .catch((e) => e);
    expect(fieldOf(err)).toBe("trackingCode");
  });

  it("saves carrier, tracking code and ship time, and records one SHIPPED event", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(order());
    const res = await giftService.updateRedemptionStatus("r1", { ...SHIP, carrier: " GHN " }, "admin");
    expect(mockTx.giftRedemption.update).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: expect.objectContaining({ carrier: "GHN", trackingCode: "GHN123456", shippedAt: expect.any(Date) }),
    });
    expect(res?.changed).toBe(true);
    expect(events()).toEqual([
      expect.objectContaining({ type: "SHIPPED", data: { carrier: "GHN", trackingCode: "GHN123456" } }),
    ]);
  });

  it("re-shipping with the same code changes nothing", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(
      order({ status: "SHIPPED", carrier: "GHN", trackingCode: "GHN123456" }),
    );
    const res = await giftService.updateRedemptionStatus("r1", SHIP);
    expect(res?.changed).toBe(false);
    expect(mockTx.giftRedemption.update).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
  });

  it("re-shipping with another code is refused, not dropped", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(
      order({ status: "SHIPPED", carrier: "GHN", trackingCode: "GHN123456" }),
    );
    const err = await giftService
      .updateRedemptionStatus("r1", { ...SHIP, carrier: "GHTK", trackingCode: "B2" })
      .catch((e) => e);
    expect(err.statusResponse.status).toBe(409);
    expect(mockTx.giftRedemption.update).not.toHaveBeenCalled();
  });
});

describe("updating the tracking code", () => {
  const TRACK = { carrier: "GHN", trackingCode: "GHN999" };

  it("only works while the order is SHIPPED", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(order({ status: "DELIVERED" }));
    const err = await giftService.updateTracking("r1", TRACK, "admin").catch((e) => e);
    expect(err.statusResponse.status).toBe(422);
  });

  it("writes nothing when both values are unchanged", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(order({ status: "SHIPPED", ...TRACK }));
    await giftService.updateTracking("r1", TRACK, "admin");
    expect(mockTx.giftRedemption.update).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
  });

  it("records the previous values", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(
      order({ status: "SHIPPED", carrier: "GHN", trackingCode: "GHN123456" }),
    );
    await giftService.updateTracking("r1", TRACK, "admin");
    expect(events()).toEqual([
      expect.objectContaining({
        type: "TRACKING_UPDATED",
        actorRole: "ADMIN",
        actorId: "admin",
        data: { carrier: "GHN", trackingCode: "GHN999", previousCarrier: "GHN", previousTrackingCode: "GHN123456" },
      }),
    ]);
  });
});

describe("allowedTransitionsFor", () => {
  it("lets the owner only cancel before shipping and confirm after", () => {
    expect(allowedTransitionsFor("PROCESSING", "USER")).toEqual(["CANCELLED"]);
    expect(allowedTransitionsFor("SHIPPED", "USER")).toEqual(["DELIVERED"]);
    expect(allowedTransitionsFor("DELIVERED", "USER")).toEqual([]);
    expect(allowedTransitionsFor("CANCELLED", "USER")).toEqual([]);
  });

  it("follows the order state machine", () => {
    expect(allowedTransitionsFor("PROCESSING")).toEqual(["SHIPPED", "CANCELLED"]);
    expect(allowedTransitionsFor("SHIPPED")).toEqual(["DELIVERED", "CANCELLED"]);
    expect(allowedTransitionsFor("DELIVERED")).toEqual([]);
    expect(allowedTransitionsFor("CANCELLED")).toEqual([]);
  });
});
