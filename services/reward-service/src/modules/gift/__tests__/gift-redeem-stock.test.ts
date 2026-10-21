const mockTx = {
  gift: { findFirst: jest.fn() },
  giftRedemption: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
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
  takeOneFromBatches: jest.fn(),
  returnToBatch: jest.fn(),
}));
jest.mock("../../green-point/green-point-lot.util", () => ({
  getBalance: jest.fn(async () => 1000),
  spendLotsFifo: jest.fn(),
  planRefund: jest.fn(() => ({ restore: [], expire: [] })),
}));
jest.mock("../../green-point/green-point-ledger.util", () => ({
  insertLedgerOnce: jest.fn(async () => null),
  loadPointExpirationDays: jest.fn(),
  lotExpiresAt: jest.fn(),
}));

import { HTTP_STATUS, HttpError } from "../../../constants/http-status";
import { insertLedgerOnce } from "../../green-point/green-point-ledger.util";
import { returnToBatch, takeOneFromBatches } from "../gift-stock.util";
import { giftService } from "../gift.service";

const redemption = (over: Record<string, unknown> = {}) => ({
  id: "r1",
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
  ...over,
});

beforeEach(() => {
  mockTx.gift.findFirst.mockResolvedValue({ id: "g1", greenPoints: 72 });
  mockTx.giftRedemption.create.mockResolvedValue(redemption({ batchId: null }));
  mockTx.giftRedemption.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => redemption(data));
});

describe("redeem takes stock from a batch", () => {
  it("takes one item and stores the batch on the order", async () => {
    (takeOneFromBatches as jest.Mock).mockResolvedValue("b1");
    const res = await giftService.redeem("u1", "g1", { phoneNumber: "0900000000", pickupLocation: "HCM" });
    expect(takeOneFromBatches).toHaveBeenCalledWith(mockTx, "g1", "r1", "u1", expect.any(Date));
    expect(mockTx.giftRedemption.update).toHaveBeenCalledWith({ where: { id: "r1" }, data: { batchId: "b1" } });
    expect(res.batchId).toBe("b1");
  });

  it("writes no ledger row when the gift is out of stock", async () => {
    (takeOneFromBatches as jest.Mock).mockRejectedValue(
      new HttpError(HTTP_STATUS.UNPROCESSABLE_ENTITY.withMessage("Gift is out of stock")),
    );
    await expect(
      giftService.redeem("u1", "g1", { phoneNumber: "0900000000", pickupLocation: "HCM" }),
    ).rejects.toThrow("Gift is out of stock");
    expect(insertLedgerOnce).not.toHaveBeenCalled();
  });
});

describe("cancel returns stock only from PROCESSING", () => {
  it("returns the item once for a PROCESSING order", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(redemption());
    await giftService.updateRedemptionStatus("r1", "CANCELLED", "admin");
    expect(returnToBatch).toHaveBeenCalledTimes(1);
    expect(returnToBatch).toHaveBeenCalledWith(mockTx, expect.objectContaining({ id: "r1", batchId: "b1" }), "admin", expect.any(Date));
  });

  it("leaves stock alone for a SHIPPED order", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(redemption({ status: "SHIPPED" }));
    await giftService.updateRedemptionStatus("r1", "CANCELLED", "admin");
    expect(returnToBatch).not.toHaveBeenCalled();
  });

  it("does not return stock when the status does not change to CANCELLED", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(redemption());
    await giftService.updateRedemptionStatus("r1", "SHIPPED", "admin");
    expect(returnToBatch).not.toHaveBeenCalled();
  });
});
