/**
 * Bước duyệt hồ sơ. Điểm quan trọng nhất: tổ chức và outbox event provisioning phải được
 * ghi trong CÙNG một transaction — nếu tách ra sẽ có lúc tổ chức tồn tại mà không có gì
 * lên lịch tạo tài khoản cho nó.
 */

const txFake = {
  organization: { create: jest.fn() },
  organizationChannel: { createMany: jest.fn() },
  organizationApplication: { update: jest.fn() },
  organizationApplicationEvent: { createMany: jest.fn() },
};
const transactionMock = jest.fn(
  async (cb: (tx: unknown) => unknown) => cb(txFake),
);
const findOrganizationsMock = jest.fn();
const emitOutboxMock = jest.fn();
const findByIdMock = jest.fn();
const findByIdWithRelationsMock = jest.fn();
const updateMock = jest.fn();
const recordEventMock = jest.fn();
const countDocumentsMock = jest.fn();
const rejectedEmailMock = jest.fn();
const needsInfoEmailMock = jest.fn();
const issueTrackingTokenMock = jest.fn();

jest.mock("../../../config/prisma.client", () => ({
  __esModule: true,
  default: {
    $transaction: transactionMock,
    organization: { findMany: (...a: unknown[]) => findOrganizationsMock(...a) },
  },
}));

jest.mock("../../../outbox/outbox.writer", () => ({
  emitOutbox: (...a: unknown[]) => emitOutboxMock(...a),
}));

jest.mock("../organization-application.repository", () => ({
  organizationApplicationRepository: {
    findById: (...a: unknown[]) => findByIdMock(...a),
    findByIdWithRelations: (...a: unknown[]) => findByIdWithRelationsMock(...a),
    update: (...a: unknown[]) => updateMock(...a),
    recordEvent: (...a: unknown[]) => recordEventMock(...a),
    countDocumentsForApplication: (...a: unknown[]) => countDocumentsMock(...a),
  },
}));

jest.mock("../organization-application-notify.client", () => ({
  enqueueApplicationRejectedEmail: (...a: unknown[]) => rejectedEmailMock(...a),
  enqueueApplicationNeedsInfoEmail: (...a: unknown[]) => needsInfoEmailMock(...a),
}));

jest.mock("../organization-application-otp.service", () => ({
  organizationApplicationOtpService: {
    issueTrackingToken: (...a: unknown[]) => issueTrackingTokenMock(...a),
  },
}));

import { organizationApplicationAdminService } from "../organization-application-admin.service";

const ADMIN = "admin-1";

const application = (overrides: Record<string, unknown> = {}) => ({
  id: "app-1",
  code: "ORG-ABCD1234",
  orgType: "CLUB",
  status: "UNDER_REVIEW",
  contactEmail: "clb@uit.edu.vn",
  emailVerifiedAt: new Date(),
  legalRepEmail: "vana@gmail.com",
  profile: {
    name: "CLB Tình nguyện UIT",
    logoUrl: "https://res.cloudinary.com/demo/logo.png",
    address: "Thủ Đức",
  },
  channels: [{ type: "FACEBOOK_PAGE", url: "https://facebook.com/clbtn" }],
  ...overrides,
});

describe("OrganizationApplicationAdminService.decide", () => {
  beforeEach(() => {
    findByIdMock.mockResolvedValue(application());
    findByIdWithRelationsMock.mockResolvedValue({
      ...application({ status: "APPROVED" }),
      documents: [],
      events: [],
      createdAt: new Date(),
      reviewedAt: new Date(),
      organizationId: "org-1",
      reviewNote: null,
      rejectReason: null,
      lane: "A",
      documentsWaived: true,
      documentsWaivedReason: "Email tên miền uit.edu.vn",
      legalRepName: null,
      legalRepIdType: null,
      legalRepIdLast4: null,
      legalRepPhone: null,
      legalRepPosition: null,
      submittedByUserId: null,
      consentedAt: new Date(),
      reviewerId: ADMIN,
      claimedAt: new Date(),
      accountProvisionedAt: null,
      purgedAt: null,
    });
    countDocumentsMock.mockResolvedValue(1);
    findOrganizationsMock.mockResolvedValue([]);
    txFake.organization.create.mockResolvedValue({ id: "org-1" });
    updateMock.mockResolvedValue(undefined);
    recordEventMock.mockResolvedValue(undefined);
    rejectedEmailMock.mockResolvedValue(undefined);
    issueTrackingTokenMock.mockResolvedValue({ token: "track" });
  });

  it("duyệt lane A: tổ chức ACTIVE, có tick, và outbox event nằm cùng transaction", async () => {
    await organizationApplicationAdminService.decide("app-1", ADMIN, {
      decision: "APPROVE",
      lane: "A",
      documentsWaived: true,
      documentsWaivedReason: "Email tên miền uit.edu.vn",
    });

    const orgData = txFake.organization.create.mock.calls[0][0].data;
    expect(orgData).toMatchObject({
      status: 1,
      kycStatus: "APPROVED",
      trustTier: "VERIFIED",
      ownerId: null,
      isEmailVerified: true,
    });
    expect(orgData.verificationExpiresAt).toBeNull();

    const [tx, outboxEvent] = emitOutboxMock.mock.calls[0];
    expect(tx).toBe(txFake);
    expect(outboxEvent).toMatchObject({
      aggregateType: "organization_application",
      eventType: "ORG_ACCOUNT_PROVISION",
      dedupKey: "ORG_ACCOUNT_PROVISION:app-1",
    });
  });

  it("duyệt lane B: chưa cấp tick và có hạn tái thẩm định 12 tháng", async () => {
    await organizationApplicationAdminService.decide("app-1", ADMIN, {
      decision: "APPROVE",
      lane: "B",
    });

    const orgData = txFake.organization.create.mock.calls[0][0].data;
    expect(orgData.trustTier).toBe("NONE");
    expect(orgData.verificationExpiresAt).toBeInstanceOf(Date);
  });

  it("miễn giấy tờ bắt buộc có lý do và được ghi vào audit log", async () => {
    await expect(
      organizationApplicationAdminService.decide("app-1", ADMIN, {
        decision: "APPROVE",
        lane: "A",
        documentsWaived: true,
      }),
    ).rejects.toMatchObject({ statusResponse: { code: "VALIDATION_ERROR" } });

    await organizationApplicationAdminService.decide("app-1", ADMIN, {
      decision: "APPROVE",
      lane: "A",
      documentsWaived: true,
      documentsWaivedReason: "Email tên miền uit.edu.vn",
    });
    const events = txFake.organizationApplicationEvent.createMany.mock.calls
      .at(-1)?.[0].data;
    expect(events.map((e: { eventType: string }) => e.eventType)).toContain(
      "DOCUMENTS_WAIVED",
    );
  });

  it("không có giấy tờ và cũng không miễn thì không duyệt được", async () => {
    countDocumentsMock.mockResolvedValue(0);

    await expect(
      organizationApplicationAdminService.decide("app-1", ADMIN, {
        decision: "APPROVE",
        lane: "B",
      }),
    ).rejects.toMatchObject({ statusResponse: { status: 400 } });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("duyệt mà không chỉ định lane thì từ chối", async () => {
    await expect(
      organizationApplicationAdminService.decide("app-1", ADMIN, {
        decision: "APPROVE",
      }),
    ).rejects.toMatchObject({ statusResponse: { status: 400 } });
  });

  it("từ chối bắt buộc có lý do, và không tạo tổ chức", async () => {
    await expect(
      organizationApplicationAdminService.decide("app-1", ADMIN, {
        decision: "REJECT",
      }),
    ).rejects.toMatchObject({ statusResponse: { code: "VALIDATION_ERROR" } });

    await organizationApplicationAdminService.decide("app-1", ADMIN, {
      decision: "REJECT",
      rejectReason: "Giấy tờ không hợp lệ",
    });
    expect(transactionMock).not.toHaveBeenCalled();
    expect(rejectedEmailMock).toHaveBeenCalled();
  });

  it("hồ sơ đã có quyết định thì không xử lý lại", async () => {
    findByIdMock.mockResolvedValue(application({ status: "APPROVED" }));

    await expect(
      organizationApplicationAdminService.decide("app-1", ADMIN, {
        decision: "APPROVE",
        lane: "A",
      }),
    ).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_APPLICATION_ALREADY_DECIDED" },
    });
  });
});

describe("OrganizationApplicationAdminService.claim", () => {
  beforeEach(() => {
    findByIdWithRelationsMock.mockResolvedValue({
      ...application(),
      documents: [],
      events: [],
      createdAt: new Date(),
      reviewedAt: null,
      organizationId: null,
      reviewNote: null,
      rejectReason: null,
      lane: null,
      documentsWaived: false,
      documentsWaivedReason: null,
      legalRepName: null,
      legalRepIdType: null,
      legalRepIdLast4: null,
      legalRepPhone: null,
      legalRepPosition: null,
      submittedByUserId: null,
      consentedAt: new Date(),
      reviewerId: ADMIN,
      claimedAt: new Date(),
      accountProvisionedAt: null,
      purgedAt: null,
    });
    updateMock.mockResolvedValue(undefined);
    recordEventMock.mockResolvedValue(undefined);
  });

  it("hồ sơ người khác đang duyệt thì không nhận được", async () => {
    findByIdMock.mockResolvedValue(
      application({ status: "UNDER_REVIEW", reviewerId: "admin-2" }),
    );

    await expect(
      organizationApplicationAdminService.claim("app-1", ADMIN),
    ).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_APPLICATION_CLAIMED" },
    });
  });

  it("hồ sơ mới nộp thì nhận được và chuyển sang UNDER_REVIEW", async () => {
    findByIdMock.mockResolvedValue(
      application({ status: "SUBMITTED", reviewerId: null }),
    );

    await organizationApplicationAdminService.claim("app-1", ADMIN);

    expect(updateMock.mock.calls[0][1]).toMatchObject({
      status: "UNDER_REVIEW",
      reviewerId: ADMIN,
    });
  });
});

describe("OrganizationApplicationAdminService.requestMoreInfo", () => {
  beforeEach(() => {
    findByIdMock.mockResolvedValue(application());
    findByIdWithRelationsMock.mockResolvedValue({
      ...application({ status: "NEEDS_MORE_INFO" }),
      documents: [],
      events: [],
      createdAt: new Date(),
      reviewedAt: null,
      organizationId: null,
      reviewNote: "Thiếu quyết định thành lập",
      rejectReason: null,
      lane: null,
      documentsWaived: false,
      documentsWaivedReason: null,
      legalRepName: null,
      legalRepIdType: null,
      legalRepIdLast4: null,
      legalRepPhone: null,
      legalRepPosition: null,
      submittedByUserId: null,
      consentedAt: new Date(),
      reviewerId: ADMIN,
      claimedAt: new Date(),
      accountProvisionedAt: null,
      purgedAt: null,
    });
    updateMock.mockResolvedValue(undefined);
    recordEventMock.mockResolvedValue(undefined);
    needsInfoEmailMock.mockResolvedValue(undefined);
    issueTrackingTokenMock.mockResolvedValue({ token: "track" });
  });

  it("chuyển sang NEEDS_MORE_INFO, lưu note và ghi audit log", async () => {
    await organizationApplicationAdminService.requestMoreInfo(
      "app-1",
      ADMIN,
      "Thiếu quyết định thành lập",
    );

    expect(updateMock.mock.calls[0][1]).toMatchObject({
      status: "NEEDS_MORE_INFO",
      reviewerId: ADMIN,
      reviewNote: "Thiếu quyết định thành lập",
    });
    expect(recordEventMock.mock.calls[0][0]).toMatchObject({
      applicationId: "app-1",
      eventType: "INFO_REQUESTED",
      actorId: ADMIN,
      payload: { message: "Thiếu quyết định thành lập" },
    });
  });

  it("gửi mail tới hòm thư liên hệ kèm link theo dõi", async () => {
    await organizationApplicationAdminService.requestMoreInfo(
      "app-1",
      ADMIN,
      "Bổ sung giấy phép",
    );

    expect(issueTrackingTokenMock).toHaveBeenCalledWith("clb@uit.edu.vn");
    expect(needsInfoEmailMock.mock.calls[0][0]).toMatchObject({
      toEmail: "clb@uit.edu.vn",
      organizationName: "CLB Tình nguyện UIT",
      applicationCode: "ORG-ABCD1234",
      message: "Bổ sung giấy phép",
    });
    expect(needsInfoEmailMock.mock.calls[0][0].trackUrl).toContain("track");
  });

  it("mail hỏng thì hồ sơ vẫn đổi trạng thái", async () => {
    needsInfoEmailMock.mockRejectedValue(new Error("notification-service down"));

    await expect(
      organizationApplicationAdminService.requestMoreInfo(
        "app-1",
        ADMIN,
        "Bổ sung giấy phép",
      ),
    ).resolves.toMatchObject({ status: "NEEDS_MORE_INFO" });
    expect(updateMock).toHaveBeenCalled();
  });

  it("hồ sơ đã có quyết định thì không hỏi thêm được", async () => {
    findByIdMock.mockResolvedValue(application({ status: "REJECTED" }));

    await expect(
      organizationApplicationAdminService.requestMoreInfo(
        "app-1",
        ADMIN,
        "Bổ sung giấy phép",
      ),
    ).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_APPLICATION_ALREADY_DECIDED" },
    });
    expect(updateMock).not.toHaveBeenCalled();
    expect(needsInfoEmailMock).not.toHaveBeenCalled();
  });
});
