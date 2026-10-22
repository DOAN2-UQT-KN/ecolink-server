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
import { returnToBatches } from "../gift-stock.util";
import { giftService } from "../gift.service";

const order = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  code: "EL-ABCDEFGH",
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
  carrier: null,
  trackingCode: null,
  shippedAt: null,
  ...over,
});

const events = () => mockTx.giftRedemptionEvent.create.mock.calls.map((c) => c[0].data);

beforeEach(() => {
  jest.clearAllMocks();
  mockTx.$queryRaw.mockResolvedValue([{ id: "r1" }]);
  mockTx.giftRedemption.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    order(data),
  );
});

describe("the owner cancels an order", () => {
  it("refunds, restocks and records CANCELLED by the customer for a PROCESSING order", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(order());
    const res = await giftService.cancelMyRedemption("u1", "el-abcdefgh", " Đặt nhầm ");
    expect(res?.changed).toBe(true);
    expect(insertLedgerOnce).toHaveBeenCalled();
    expect(returnToBatches).toHaveBeenCalledWith(mockTx, expect.objectContaining({ id: "r1" }), "u1", expect.any(Date));
    expect(events()).toEqual([
      expect.objectContaining({
        type: "CANCELLED",
        actorRole: "USER",
        actorId: "u1",
        data: { cancelReason: "Đặt nhầm", restocked: true, returnedQuantity: 1 },
      }),
    ]);
    // Owner's view: nothing left to do on a cancelled order.
    expect(res?.redemption.allowedTransitions).toEqual([]);
  });

  it("looks the order up by its code and the caller's id only", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(order());
    await giftService.cancelMyRedemption("u1", "EL-ABCDEFGH", "x");
    const [sql, ...values] = mockTx.$queryRaw.mock.calls[0];
    expect(sql.join("?")).toContain("user_id");
    expect(values).toEqual(["EL-ABCDEFGH", "u1"]);
  });

  it("cannot cancel a SHIPPED order", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(order({ status: "SHIPPED" }));
    const err = await giftService.cancelMyRedemption("u1", "EL-ABCDEFGH", "Late").catch((e) => e);
    expect(err.statusResponse.status).toBe(422);
    expect(mockTx.giftRedemption.update).not.toHaveBeenCalled();
  });

  it("gets null for someone else's order or a malformed code", async () => {
    mockTx.$queryRaw.mockResolvedValue([]);
    expect(await giftService.cancelMyRedemption("u2", "EL-ABCDEFGH", "x")).toBeNull();
    expect(await giftService.cancelMyRedemption("u1", "not-a-code", "x")).toBeNull();
  });

  it("needs a reason", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(order());
    const err = await giftService.cancelMyRedemption("u1", "EL-ABCDEFGH", "   ").catch((e) => e);
    expect(err.data?.errors?.[0]?.path).toBe("cancelReason");
  });

  it("changes nothing when the admin already cancelled it", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(order({ status: "CANCELLED", cancelReason: "Admin" }));
    const res = await giftService.cancelMyRedemption("u1", "EL-ABCDEFGH", "Me too");
    expect(res?.changed).toBe(false);
    expect(insertLedgerOnce).not.toHaveBeenCalled();
    expect(returnToBatches).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
  });
});

describe("the owner confirms delivery", () => {
  it("moves a SHIPPED order to DELIVERED and records it as the customer", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(order({ status: "SHIPPED" }));
    const res = await giftService.confirmMyRedemption("u1", "EL-ABCDEFGH");
    expect(res?.redemption.status).toBe("DELIVERED");
    expect(events()).toEqual([
      expect.objectContaining({ type: "DELIVERED", fromStatus: "SHIPPED", actorRole: "USER", actorId: "u1" }),
    ]);
  });

  it("cannot confirm an order that has not shipped", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(order());
    const err = await giftService.confirmMyRedemption("u1", "EL-ABCDEFGH").catch((e) => e);
    expect(err.statusResponse.status).toBe(422);
  });

  it("records nothing when the admin already marked it delivered", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(order({ status: "DELIVERED" }));
    const res = await giftService.confirmMyRedemption("u1", "EL-ABCDEFGH");
    expect(res?.changed).toBe(false);
    expect(events()).toEqual([]);
  });
});
