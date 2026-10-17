const approved = jest.fn().mockResolvedValue(undefined);
const rejected = jest.fn().mockResolvedValue(undefined);
const inReview = jest.fn().mockResolvedValue(undefined);

jest.mock("../../report/report-status-notify.client", () => ({
  enqueueReportApprovedWebsiteNotification: (...a: unknown[]) => approved(...a),
  enqueueReportRejectedWebsiteNotification: (...a: unknown[]) => rejected(...a),
  enqueueReportInReviewWebsiteNotification: (...a: unknown[]) => inReview(...a),
}));

import { reportVerifiedPublisher } from "../report-verified.publisher";

const event = (payload: Record<string, unknown>) => ({
  id: "evt-1",
  eventType: "REPORT_VERIFIED",
  payload: { reportId: "r1", userId: "u1", reportTitle: "Rác", statusChanged: true, ...payload },
});
const base = { userId: "u1", reportId: "r1", reportTitle: "Rác" };

describe("ReportVerifiedPublisher", () => {
  beforeEach(() => jest.clearAllMocks());

  it("notifies approval on 21", async () => {
    await reportVerifiedPublisher.publish(event({ reportStatus: 21 }));
    expect(approved).toHaveBeenCalledWith(base);
  });

  it("notifies rejection without a free-text reason on 2", async () => {
    await reportVerifiedPublisher.publish(event({ reportStatus: 2 }));
    expect(rejected).toHaveBeenCalledWith({ ...base, rejectReason: "" });
  });

  it("notifies review on 9", async () => {
    await reportVerifiedPublisher.publish(event({ reportStatus: 9 }));
    expect(inReview).toHaveBeenCalledWith(base);
  });

  it.each([
    ["status unchanged", { reportStatus: 21, statusChanged: false }],
    ["no owner", { reportStatus: 21, userId: null }],
    ["unrelated status", { reportStatus: 22 }],
  ])("sends nothing when %s", async (_name, payload) => {
    await reportVerifiedPublisher.publish(event(payload));
    expect(approved).not.toHaveBeenCalled();
    expect(rejected).not.toHaveBeenCalled();
    expect(inReview).not.toHaveBeenCalled();
  });

  it("rethrows so the relay retries", async () => {
    approved.mockRejectedValueOnce(new Error("notification down"));
    await expect(reportVerifiedPublisher.publish(event({ reportStatus: 21 }))).rejects.toThrow("notification down");
  });
});
