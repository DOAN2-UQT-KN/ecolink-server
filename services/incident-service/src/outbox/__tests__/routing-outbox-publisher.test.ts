/**
 * Relay giờ phục vụ hai loại event khác nhau: event thưởng đi SQS sang reward-service, còn
 * event provisioning gọi thẳng identity. Định tuyến sai nghĩa là tài khoản tổ chức không bao
 * giờ được tạo, nên nhánh này được kiểm riêng.
 */

import { RoutingOutboxPublisher } from "../outbox-publisher";
import { OutboxEventType } from "../outbox.types";

describe("RoutingOutboxPublisher", () => {
  const event = (eventType: string) => ({
    id: "evt-1",
    eventType,
    payload: {},
  });

  it("gửi event đã khai báo tới publisher tương ứng", async () => {
    const provisioning = { publish: jest.fn().mockResolvedValue(undefined) };
    const fallback = jest.fn();

    const publisher = new RoutingOutboxPublisher(
      { [OutboxEventType.ORG_ACCOUNT_PROVISION]: provisioning },
      fallback,
    );
    await publisher.publish(event(OutboxEventType.ORG_ACCOUNT_PROVISION));

    expect(provisioning.publish).toHaveBeenCalled();
    // Fallback là SQS và chỉ được dựng khi thật sự cần, nên không được đụng tới.
    expect(fallback).not.toHaveBeenCalled();
  });

  it("event không khai báo rơi về transport mặc định", async () => {
    const sqs = { publish: jest.fn().mockResolvedValue(undefined) };
    const fallback = jest.fn(() => sqs);

    const publisher = new RoutingOutboxPublisher({}, fallback);
    await publisher.publish(event(OutboxEventType.REPORT_COMPLETION_GREEN_POINTS));

    expect(fallback).toHaveBeenCalled();
    expect(sqs.publish).toHaveBeenCalled();
  });

  it("lỗi của publisher được ném lên để relay retry", async () => {
    const failing = {
      publish: jest.fn().mockRejectedValue(new Error("identity down")),
    };

    const publisher = new RoutingOutboxPublisher(
      { [OutboxEventType.ORG_ACCOUNT_PROVISION]: failing },
      () => failing,
    );

    await expect(
      publisher.publish(event(OutboxEventType.ORG_ACCOUNT_PROVISION)),
    ).rejects.toThrow("identity down");
  });
});
