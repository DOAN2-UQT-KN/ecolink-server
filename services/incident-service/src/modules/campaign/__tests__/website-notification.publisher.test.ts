const send = jest.fn();
jest.mock("../notification-jobs.client", () => ({
  enqueueWebsiteNotificationsToUsers: (...a: unknown[]) => send(...a),
}));

import { websiteNotificationPublisher } from "../website-notification.publisher";

const event = (payload: unknown) => ({ id: "e1", eventType: "WEBSITE_NOTIFICATION", payload: payload as never });

describe("WebsiteNotificationPublisher", () => {
  beforeEach(() => send.mockReset());

  it("sends the notification the transaction wrote", async () => {
    send.mockResolvedValue(undefined);
    await websiteNotificationPublisher.publish(
      event({ kind: "CAMPAIGN_SHIFT_CLOSED", userIds: ["u1"], payload: { campaignId: "c1" } }),
    );
    expect(send).toHaveBeenCalledWith({
      kind: "CAMPAIGN_SHIFT_CLOSED",
      userIds: ["u1"],
      payload: { campaignId: "c1" },
    });
  });

  it("throws when sending fails, so the relay retries", async () => {
    send.mockRejectedValue(new Error("400"));
    await expect(
      websiteNotificationPublisher.publish(event({ kind: "X", userIds: ["u1"], payload: {} })),
    ).rejects.toThrow("400");
  });

  it("rejects an incomplete payload and skips an empty audience", async () => {
    await expect(websiteNotificationPublisher.publish(event({ userIds: [] }))).rejects.toThrow(
      "incomplete",
    );
    await websiteNotificationPublisher.publish(event({ kind: "X", userIds: [] }));
    expect(send).not.toHaveBeenCalled();
  });
});
