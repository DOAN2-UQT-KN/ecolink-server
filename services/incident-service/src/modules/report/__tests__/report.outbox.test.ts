/**
 * Producer-side outbox tests for `adminMarkReportDone`.
 *
 * The heavy import graph (queue runner, prisma, vote enrichment) is mocked so
 * the test focuses on: (1) the green-point event is emitted with the right
 * payload/dedupKey inside the transaction, (2) the flow no longer calls reward
 * over HTTP (decoupled), (3) a failing emit rejects instead of being swallowed.
 */

const txFake = { __tx: true };
const transactionMock = jest.fn(
  async (cb: (tx: unknown) => unknown) => cb(txFake),
);
const enqueueMock = jest.fn();
const emitOutboxMock = jest.fn();
const findByIdMock = jest.fn();
const markReportAsDoneMock = jest.fn();
const notifyMock = jest.fn();

jest.mock("../../../queue/register", () => ({
  backgroundJobDispatcher: { enqueue: enqueueMock },
}));

jest.mock("../../../config/prisma.client", () => ({
  __esModule: true,
  default: { $transaction: transactionMock },
}));

jest.mock("../../../outbox/outbox.writer", () => ({
  emitOutbox: (...args: unknown[]) => emitOutboxMock(...args),
}));

jest.mock("../report.repository", () => ({
  reportRepository: {
    findById: (...a: unknown[]) => findByIdMock(...a),
    markReportAsDone: (...a: unknown[]) => markReportAsDoneMock(...a),
  },
}));

jest.mock("../report.entity", () => ({
  toReportResponse: (r: unknown) => r,
}));

jest.mock("../report-status-notify.client", () => ({
  enqueueReportStatusWebsiteNotification: (...a: unknown[]) => notifyMock(...a),
}));

import { reportService } from "../report.service";
import { OutboxEventType } from "../../../outbox/outbox.types";

describe("adminMarkReportDone (outbox producer)", () => {
  beforeEach(() => {
    notifyMock.mockResolvedValue(undefined);
    emitOutboxMock.mockResolvedValue(undefined);
    findByIdMock.mockResolvedValue({
      id: "report-1",
      userId: "user-1",
      status: 12,
    });
    markReportAsDoneMock.mockResolvedValue({
      id: "report-1",
      userId: "user-1",
      title: "A report",
    });
    // Bypass vote enrichment (queries DB otherwise).
    jest
      .spyOn(reportService as never as { withReportVote: jest.Mock }, "withReportVote")
      .mockImplementation((r: unknown) => r as never);
  });

  it("emit REPORT_COMPLETION_GREEN_POINTS đúng payload + dedupKey, trong transaction", async () => {
    await reportService.adminMarkReportDone("report-1");

    expect(transactionMock).toHaveBeenCalledTimes(1);
    // markReportAsDone phải chạy với tx (cùng transaction với emit).
    expect(markReportAsDoneMock).toHaveBeenCalledWith("report-1", txFake);
    expect(emitOutboxMock).toHaveBeenCalledTimes(1);
    const [tx, event] = emitOutboxMock.mock.calls[0];
    expect(tx).toBe(txFake);
    expect(event).toMatchObject({
      aggregateType: "report",
      aggregateId: "report-1",
      eventType: OutboxEventType.REPORT_COMPLETION_GREEN_POINTS,
      payload: { reportId: "report-1", userId: "user-1" },
      dedupKey: "REPORT_COMPLETION_GREEN_POINTS:report-1",
    });
    // reward-service decides the amount (spec 013 FR-020).
    expect(event.payload).not.toHaveProperty("points");
  });

  it("KHÔNG gọi reward qua hàng đợi/HTTP trong mark-done (đã tách rời)", async () => {
    await reportService.adminMarkReportDone("report-1");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("report không có người tạo -> không emit", async () => {
    markReportAsDoneMock.mockResolvedValue({ id: "report-1", userId: null, title: "A report" });
    await reportService.adminMarkReportDone("report-1");
    expect(emitOutboxMock).not.toHaveBeenCalled();
  });

  it("emit throw -> mark-done reject (không nuốt lỗi)", async () => {
    emitOutboxMock.mockRejectedValue(new Error("outbox insert failed"));
    await expect(reportService.adminMarkReportDone("report-1")).rejects.toThrow(
      "outbox insert failed",
    );
  });
});
