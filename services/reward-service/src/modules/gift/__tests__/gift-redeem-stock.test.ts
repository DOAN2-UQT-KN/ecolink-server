const mockTx = {
  $queryRaw: jest.fn(),
  gift: { findFirst: jest.fn() },
  giftRedemption: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
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
  returnToBatches: jest.fn(async () => 1),
  toRedemptionSources: jest.fn(() => []),
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

import { Prisma } from "@prisma/client";
import prisma from "../../../config/prisma.client";
import { HTTP_STATUS, HttpError } from "../../../constants/http-status";
import { insertLedgerOnce } from "../../green-point/green-point-ledger.util";
import { getBalance, spendLotsFifo } from "../../green-point/green-point-lot.util";
import { returnToBatches, takeFromBatches } from "../gift-stock.util";
import { giftService } from "../gift.service";

const DELIVERY = {
  phoneNumber: "0900000000",
  recipientName: " An Nguyễn ",
  pickupLocation: "1 Lê Lợi, Quận 1, TP.HCM",
  addressDetail: "  ",
  deliveryLatitude: 10.77,
  deliveryLongitude: 106.7,
  deliveryNote: "Gọi trước khi giao",
};

const redemption = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  code: "EL-ABCDEFGH",
  carrier: null,
  trackingCode: null,
  shippedAt: null,
  userId: "u1",
  giftId: "g1",
  greenPointsSpent: 72,
  quantity: 1,
  unitPoints: 72,
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

beforeEach(() => {
  mockTx.$queryRaw.mockResolvedValue([{ id: "r1" }]);
  mockTx.gift.findFirst.mockResolvedValue({ id: "g1", greenPoints: 72, stockRemaining: 10 });
  mockTx.giftRedemption.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    redemption({ ...data, id: "r1", batchId: null }),
  );
  (takeFromBatches as jest.Mock).mockResolvedValue([{ batchId: "b1", quantity: 1 }]);
  (insertLedgerOnce as jest.Mock).mockClear();
  (returnToBatches as jest.Mock).mockClear();
  mockTx.giftRedemption.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => redemption(data));
});

describe("redeem takes stock from the batches", () => {
  it("orders one item when no quantity is sent and writes no batch on the order", async () => {
    const res = await giftService.redeem("u1", "g1", DELIVERY);
    expect(takeFromBatches).toHaveBeenCalledWith(mockTx, "g1", "r1", "u1", 1, expect.any(Date));
    expect(mockTx.giftRedemption.update).not.toHaveBeenCalled();
    expect(res).toMatchObject({ quantity: 1, unitPoints: 72, greenPointsSpent: 72 });
  });

  it("charges the unit price times the quantity in one ledger row and records the quantity", async () => {
    mockTx.giftRedemptionEvent.create.mockClear();
    const res = await giftService.redeem("u1", "g1", { ...DELIVERY, quantity: 3 });
    expect(mockTx.giftRedemption.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ quantity: 3, unitPoints: 72, greenPointsSpent: 216 }),
    });
    expect(takeFromBatches).toHaveBeenCalledWith(mockTx, "g1", "r1", "u1", 3, expect.any(Date));
    expect(spendLotsFifo).toHaveBeenCalledWith(mockTx, "u1", "r1", 216, expect.any(Date));
    expect(insertLedgerOnce).toHaveBeenCalledTimes(1);
    expect(insertLedgerOnce).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({ points: -216, metadata: { giftId: "g1", listPrice: 72, quantity: 3 } }),
    );
    expect(mockTx.giftRedemptionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "CREATED", data: { quantity: 3 } }),
    });
    expect(res).toMatchObject({ quantity: 3, greenPointsSpent: 216 });
  });

  it("refuses more items than the stock holds before writing anything", async () => {
    mockTx.gift.findFirst.mockResolvedValue({ id: "g1", greenPoints: 72, stockRemaining: 2 });
    mockTx.giftRedemption.create.mockClear();
    await expect(giftService.redeem("u1", "g1", { ...DELIVERY, quantity: 3 })).rejects.toThrow("Not enough stock");
    expect(mockTx.giftRedemption.create).not.toHaveBeenCalled();
    expect(insertLedgerOnce).not.toHaveBeenCalled();
  });

  it("says out of stock when nothing is left", async () => {
    mockTx.gift.findFirst.mockResolvedValue({ id: "g1", greenPoints: 72, stockRemaining: 0 });
    await expect(giftService.redeem("u1", "g1", DELIVERY)).rejects.toThrow("Gift is out of stock");
  });

  it("refuses when the balance covers the unit price but not the total", async () => {
    (getBalance as jest.Mock).mockResolvedValueOnce(200);
    await expect(giftService.redeem("u1", "g1", { ...DELIVERY, quantity: 3 })).rejects.toThrow(
      "Insufficient green points",
    );
    expect(takeFromBatches).not.toHaveBeenCalledWith(mockTx, "g1", "r1", "u1", 3, expect.any(Date));
  });

  it("writes no ledger row when the batches run short", async () => {
    (takeFromBatches as jest.Mock).mockRejectedValue(
      new HttpError(HTTP_STATUS.UNPROCESSABLE_ENTITY.withMessage("Not enough stock")),
    );
    await expect(giftService.redeem("u1", "g1", { ...DELIVERY, quantity: 2 })).rejects.toThrow("Not enough stock");
    expect(insertLedgerOnce).not.toHaveBeenCalled();
  });
});

const cancel = { status: "CANCELLED" as const, cancelReason: "User changed mind" };

describe("redeem stores the delivery details", () => {
  it("saves recipient, pin and note; blank optional fields become null", async () => {
    await giftService.redeem("u1", "g1", DELIVERY);
    expect(mockTx.giftRedemption.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        phoneNumber: "0900000000",
        recipientName: "An Nguyễn",
        pickupLocation: "1 Lê Lợi, Quận 1, TP.HCM",
        addressDetail: null,
        deliveryLatitude: 10.77,
        deliveryLongitude: 106.7,
        deliveryNote: "Gọi trước khi giao",
      }),
    });
  });
});

describe("redeem gives the order a code and history", () => {
  it("stores an EL- code and records CREATED by the customer", async () => {
    mockTx.giftRedemptionEvent.create.mockClear();
    await giftService.redeem("u1", "g1", DELIVERY);
    const { data } = mockTx.giftRedemption.create.mock.calls.at(-1)[0];
    expect(data.code).toMatch(/^EL-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    expect(mockTx.giftRedemptionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "CREATED", toStatus: "PROCESSING", actorRole: "USER", actorId: "u1" }),
    });
  });
});

describe("cancel returns stock to the batches", () => {
  it("returns the items once for a PROCESSING order and records how many", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(redemption({ quantity: 3, unitPoints: 24 }));
    (returnToBatches as jest.Mock).mockResolvedValueOnce(3);
    mockTx.giftRedemptionEvent.create.mockClear();
    await giftService.updateRedemptionStatus("r1", cancel, "admin");
    expect(returnToBatches).toHaveBeenCalledTimes(1);
    expect(returnToBatches).toHaveBeenCalledWith(mockTx, expect.objectContaining({ id: "r1" }), "admin", expect.any(Date));
    expect(mockTx.giftRedemption.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ restocked: true }) }),
    );
    expect(mockTx.giftRedemptionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "CANCELLED", data: expect.objectContaining({ restocked: true, returnedQuantity: 3 }) }),
    });
  });

  it("marks an order that took from no batch as not restocked", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(redemption({ batchId: null }));
    (returnToBatches as jest.Mock).mockResolvedValueOnce(0);
    await giftService.updateRedemptionStatus("r1", cancel, "admin");
    expect(mockTx.giftRedemption.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ restocked: false }) }),
    );
  });

  it("leaves stock alone for a SHIPPED order the admin says did not come back", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(redemption({ status: "SHIPPED" }));
    mockTx.giftRedemptionEvent.create.mockClear();
    await giftService.updateRedemptionStatus("r1", { ...cancel, restock: false }, "admin");
    expect(returnToBatches).not.toHaveBeenCalled();
    expect(mockTx.giftRedemptionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ data: expect.objectContaining({ restocked: false, returnedQuantity: 0 }) }),
    });
  });

  it("does not return stock when the status does not change to CANCELLED", async () => {
    mockTx.giftRedemption.findUnique.mockResolvedValue(redemption());
    await giftService.updateRedemptionStatus(
      "r1",
      { status: "SHIPPED", carrier: "GHN", trackingCode: "GHN123" },
      "admin",
    );
    expect(returnToBatches).not.toHaveBeenCalled();
  });
});

describe("serialization conflicts", () => {
  const conflict = () =>
    new Prisma.PrismaClientKnownRequestError("conflict", { code: "P2034", clientVersion: "6" });
  const body = DELIVERY;

  beforeEach(() => {
    (prisma.$transaction as jest.Mock).mockClear();
  });

  it("runs the redemption again after a conflict", async () => {
    (prisma.$transaction as jest.Mock).mockRejectedValueOnce(conflict());
    const res = await giftService.redeem("u1", "g1", body);
    expect(res.status).toBe("PROCESSING");
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("retries with a new code when the drawn one is taken", async () => {
    const clash = new Prisma.PrismaClientKnownRequestError("dup", {
      code: "P2002",
      clientVersion: "6",
      meta: { target: ["code"] },
    });
    (prisma.$transaction as jest.Mock).mockRejectedValueOnce(clash);
    const res = await giftService.redeem("u1", "g1", body);
    expect(res.status).toBe("PROCESSING");
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("does not retry other unique violations", async () => {
    const other = new Prisma.PrismaClientKnownRequestError("dup", {
      code: "P2002",
      clientVersion: "6",
      meta: { target: ["idempotency_key"] },
    });
    (prisma.$transaction as jest.Mock).mockRejectedValueOnce(other);
    await expect(giftService.redeem("u1", "g1", body)).rejects.toBe(other);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("gives up with 409 after 15 attempts", async () => {
    for (let i = 0; i < 15; i++) (prisma.$transaction as jest.Mock).mockRejectedValueOnce(conflict());
    const err = await giftService.redeem("u1", "g1", body).catch((e) => e);
    expect(err.statusResponse.status).toBe(409);
    expect(prisma.$transaction).toHaveBeenCalledTimes(15);
  });
});
