/**
 * Nửa sau của saga duyệt hồ sơ. Đây là chỗ dễ vỡ nhất vì ghi sang hai database khác nhau,
 * nên trọng tâm là: chạy lại (relay retry) không tạo tài khoản trùng và không gửi lại email,
 * còn lỗi thì phải ném ra để relay giữ event ở PENDING.
 */

const txFake = {
  organization: { update: jest.fn() },
  organizationMember: { upsert: jest.fn() },
  organizationApplication: { update: jest.fn() },
  organizationApplicationEvent: { create: jest.fn() },
};
const transactionMock = jest.fn(
  async (cb: (tx: unknown) => unknown) => cb(txFake),
);
const provisionOrgAccountMock = jest.fn();
const activationEmailMock = jest.fn();

jest.mock("../../../config/prisma.client", () => ({
  __esModule: true,
  default: { $transaction: transactionMock },
}));

jest.mock("../identity-org-account.client", () => ({
  provisionOrgAccount: (...a: unknown[]) => provisionOrgAccountMock(...a),
}));

jest.mock("../organization-application-notify.client", () => ({
  enqueueOrgAccountActivationEmail: (...a: unknown[]) =>
    activationEmailMock(...a),
}));

import { organizationAccountProvisionPublisher } from "../organization-account-provision.publisher";

const event = {
  id: "outbox-1",
  eventType: "ORG_ACCOUNT_PROVISION",
  payload: {
    applicationId: "app-1",
    organizationId: "org-1",
    email: "clb@uit.edu.vn",
    displayName: "CLB Tình nguyện UIT",
  },
};

describe("OrganizationAccountProvisionPublisher", () => {
  beforeEach(() => {
    activationEmailMock.mockResolvedValue(undefined);
    provisionOrgAccountMock.mockResolvedValue({
      userId: "user-1",
      activationToken: "activation-token",
      alreadyProvisioned: false,
    });
  });

  it("gắn tài khoản ORG làm owner, thêm vào members và gửi link đặt mật khẩu", async () => {
    await organizationAccountProvisionPublisher.publish(event);

    expect(txFake.organization.update).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: { ownerId: "user-1", updatedBy: "user-1" },
    });
    expect(txFake.organizationMember.upsert).toHaveBeenCalled();
    expect(txFake.organizationApplication.update.mock.calls[0][0].data)
      .toHaveProperty("accountProvisionedAt");
    expect(activationEmailMock.mock.calls[0][0]).toMatchObject({
      toEmail: "clb@uit.edu.vn",
      expiresInHours: 72,
    });
    // Không bao giờ gửi mật khẩu tạm.
    expect(JSON.stringify(activationEmailMock.mock.calls[0][0])).not.toContain(
      "password",
    );
  });

  it("chạy lại sau khi identity đã tạo tài khoản thì không gửi email lần hai", async () => {
    provisionOrgAccountMock.mockResolvedValue({
      userId: "user-1",
      activationToken: null,
      alreadyProvisioned: true,
    });

    await organizationAccountProvisionPublisher.publish(event);

    expect(txFake.organization.update).toHaveBeenCalled();
    expect(activationEmailMock).not.toHaveBeenCalled();
  });

  it("identity lỗi thì ném ra để relay retry, không đụng vào DB incident", async () => {
    provisionOrgAccountMock.mockRejectedValue(new Error("identity down"));

    await expect(
      organizationAccountProvisionPublisher.publish(event),
    ).rejects.toThrow("identity down");
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("payload thiếu trường bắt buộc thì từ chối ngay", async () => {
    await expect(
      organizationAccountProvisionPublisher.publish({
        ...event,
        payload: { applicationId: "app-1" },
      }),
    ).rejects.toThrow("ORG_ACCOUNT_PROVISION payload is incomplete");
  });
});
