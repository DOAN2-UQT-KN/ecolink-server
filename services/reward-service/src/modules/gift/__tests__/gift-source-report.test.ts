jest.mock("../../../config/prisma.client", () => ({ __esModule: true, default: {} }));

import { buildSourceReport, parseRange, toCsv, type ReportInput } from "../gift-source-report";

const NOW = new Date("2026-12-31T05:00:00.000Z");
const RANGE = parseRange("2026-10-01", "2026-12-31", NOW);

/** The design example: Công ty Xanh, 50 bottles at 120.000 đ, 41 delivered, 2 held, 1 damaged. */
function designInput(): ReportInput {
  return {
    sourceId: "xanh",
    range: RANGE,
    now: NOW,
    batches: [
      {
        id: "b1",
        giftId: "bottle",
        giftName: "Bình nước giữ nhiệt",
        quantity: 50,
        remaining: 6,
        unitValueVnd: 120000,
        receivedAt: new Date("2026-10-05T03:00:00.000Z"),
        expiresAt: null,
      },
    ],
    delivered: Array.from({ length: 41 }, (_, i) => ({ batchId: "b1", userId: `u${i}`, quantity: 1 })),
    holding: [{ batchId: "b1", quantity: 1 }, { batchId: "b1", quantity: 1 }],
    writeOffs: [{ batchId: "b1", type: "ADJUST_OUT", reason: "DAMAGED", quantity: -1 }],
  };
}

describe("buildSourceReport", () => {
  it("matches the design example", () => {
    const r = buildSourceReport(designInput());
    expect(r.totals).toEqual({
      received: 50,
      delivered: 41,
      holding: 2,
      shrinkage: { DAMAGED: 1, LOST: 0, COUNT_SHORTAGE: 0, RETURN_TO_SOURCE: 0 },
      expired: 0,
      inStock: 6,
      valueDeliveredVnd: 4920000,
      recipients: 41,
    });
    expect(r.gifts).toHaveLength(1);
    expect(r.gifts[0]).toMatchObject({ giftId: "bottle", received: 50, recipients: 41 });
  });

  it("counts one recipient once across several orders", () => {
    const input = designInput();
    input.delivered = [
      { batchId: "b1", userId: "an", quantity: 1 },
      { batchId: "b1", userId: "an", quantity: 1 },
    ];
    expect(buildSourceReport(input).totals.recipients).toBe(1);
  });

  it("counts items, not orders, including an order spread over two batches", () => {
    const input = designInput();
    input.batches = [
      { ...input.batches[0], id: "b1", quantity: 10, remaining: 6 },
      { ...input.batches[0], id: "b2", quantity: 5, remaining: 4 },
    ];
    // An order of 3 delivered: 2 from b1, 1 from b2. An order of 1 still being prepared, from b1.
    input.delivered = [
      { batchId: "b1", userId: "an", quantity: 2 },
      { batchId: "b2", userId: "an", quantity: 1 },
    ];
    input.holding = [{ batchId: "b1", quantity: 1 }];
    input.writeOffs = [];
    const { totals } = buildSourceReport(input);
    expect(totals).toMatchObject({ delivered: 3, holding: 1, inStock: 10, recipients: 1, valueDeliveredVnd: 360000 });
  });

  it("gives all zeros for a source without batches", () => {
    const r = buildSourceReport({ ...designInput(), batches: [], delivered: [], holding: [], writeOffs: [] });
    expect(r.gifts).toEqual([]);
    expect(r.totals.received + r.totals.delivered + r.totals.inStock + r.totals.recipients).toBe(0);
  });

  it("does not count a batch received outside the range, nor stock in an expired batch", () => {
    const input = designInput();
    input.batches[0].receivedAt = new Date("2026-09-30T16:59:59.000Z"); // 23:59:59 on 30/9 in UTC+7
    input.batches[0].expiresAt = new Date("2026-12-30T00:00:00.000Z");
    const r = buildSourceReport(input);
    expect(r.totals.received).toBe(0);
    expect(r.totals.inStock).toBe(0);
  });
});

describe("parseRange", () => {
  it("covers whole days in UTC+7, `to` inclusive", () => {
    expect(RANGE.start.toISOString()).toBe("2026-09-30T17:00:00.000Z");
    expect(RANGE.end.toISOString()).toBe("2026-12-31T16:59:59.999Z");
  });

  it("defaults to the last 30 days ending today in UTC+7", () => {
    const r = parseRange(undefined, undefined, NOW);
    expect(r.to).toBe("2026-12-31");
    expect(r.from).toBe("2026-12-02");
  });

  it("refuses from after to, and malformed dates", () => {
    expect(() => parseRange("2026-12-31", "2026-10-01", NOW)).toThrow("from must not be after to");
    expect(() => parseRange("2026-13-01", undefined, NOW)).toThrow("from must be a date YYYY-MM-DD");
    expect(() => parseRange(undefined, "31/12/2026", NOW)).toThrow("to must be a date YYYY-MM-DD");
  });
});

describe("toCsv", () => {
  it("starts with a BOM, puts totals first and escapes commas and quotes", () => {
    const input = designInput();
    input.batches[0].giftName = 'Túi "vải", size L';
    const csv = toCsv(buildSourceReport(input));
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).trim().split("\r\n");
    expect(lines[0]).toBe(
      "gift,received,delivered,holding,damaged,lost,count_shortage,return_to_source,expired,in_stock,value_delivered_vnd,recipients",
    );
    expect(lines[1]).toBe("TOTAL,50,41,2,1,0,0,0,0,6,4920000,41");
    expect(lines[2]).toBe('"Túi ""vải"", size L",50,41,2,1,0,0,0,0,6,4920000,41');
  });
});
