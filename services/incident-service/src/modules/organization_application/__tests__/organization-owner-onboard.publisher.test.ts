/**
 * Email sau khi duyệt: user mới nhận link kích hoạt, user đã có tài khoản nhận thông báo
 * "đã được gắn vai" — tuyệt đối không phải link đặt lại mật khẩu (giống hệt phishing).
 */

const issueActivationTokenMock = jest.fn();
const activationEmailMock = jest.fn();
const attachedEmailMock = jest.fn();
const recordEventMock = jest.fn();

jest.mock("../identity-owner.client", () => ({
  issueActivationToken: (...a: unknown[]) => issueActivationTokenMock(...a),
}));

jest.mock("../organization-application-notify.client", () => ({
  enqueueAccountActivationEmail: (...a: unknown[]) => activationEmailMock(...a),
  enqueueOwnerAttachedEmail: (...a: unknown[]) => attachedEmailMock(...a),
}));

jest.mock("../organization-application.repository", () => ({
  organizationApplicationRepository: {
    recordEvent: (...a: unknown[]) => recordEventMock(...a),
  },
}));

import { organizationOwnerOnboardPublisher } from "../organization-owner-onboard.publisher";

const payload = {
  applicationId: "app-1",
  candidateId: "c-binh",
  organizationId: "org-1",
  organizationName: "CLB Xanh",
  organizationSlug: "clb-xanh",
  userId: "u-binh",
  email: "binh@gmail.com",
  fullName: "Tran Binh",
  isLegalRep: false,
};

const event = (p: unknown = payload) =>
  ({ id: "evt-1", eventType: "ORG_OWNER_ONBOARD", payload: p }) as never;

beforeEach(() => {
  jest.clearAllMocks();
  activationEmailMock.mockResolvedValue(undefined);
  attachedEmailMock.mockResolvedValue(undefined);
  recordEventMock.mockResolvedValue(undefined);
});

describe("OrganizationOwnerOnboardPublisher", () => {
  it("user chưa kích hoạt → email kích hoạt 72 giờ tới /activate-account", async () => {
    issueActivationTokenMock.mockResolvedValue({ token: "act-tok", expiresInHours: 72 });

    await organizationOwnerOnboardPublisher.publish(event());

    expect(issueActivationTokenMock).toHaveBeenCalledWith("u-binh");
    const mail = activationEmailMock.mock.calls[0][0];
    expect(mail).toMatchObject({
      toEmail: "binh@gmail.com",
      organizationName: "CLB Xanh",
      expiresInHours: 72,
    });
    expect(mail.activationUrl).toContain("/activate-account?token=act-tok");
    expect(attachedEmailMock).not.toHaveBeenCalled();
    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "OWNER_ATTACHED" }),
    );
  });

  it("user đã có tài khoản → email 'đã được gắn vai' kèm link tổ chức, không có link mật khẩu", async () => {
    issueActivationTokenMock.mockResolvedValue(null);

    await organizationOwnerOnboardPublisher.publish(event());

    expect(activationEmailMock).not.toHaveBeenCalled();
    const mail = attachedEmailMock.mock.calls[0][0];
    expect(mail.manageUrl).toContain("/organizations/clb-xanh");
    expect(JSON.stringify(mail)).not.toMatch(/reset|password|activate/i);
  });

  it("gửi mail hỏng thì ném lỗi để relay thử lại, chưa ghi audit", async () => {
    issueActivationTokenMock.mockResolvedValue(null);
    attachedEmailMock.mockRejectedValue(new Error("notification down"));

    await expect(organizationOwnerOnboardPublisher.publish(event())).rejects.toThrow(
      "notification down",
    );
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it("payload thiếu trường thì ném lỗi", async () => {
    await expect(
      organizationOwnerOnboardPublisher.publish(event({ applicationId: "app-1" })),
    ).rejects.toThrow("incomplete");
    expect(issueActivationTokenMock).not.toHaveBeenCalled();
  });
});
