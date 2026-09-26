/**
 * Bước duyệt hồ sơ. Điểm quan trọng nhất: tổ chức, các membership owner và outbox event gửi
 * email phải nằm trong CÙNG một transaction, và chỉ duyệt được khi mọi owner đã xác nhận —
 * kiểm lại ngay trong transaction dù trạng thái đã đảm bảo điều đó.
 */

const txFake = {
  organization: { create: jest.fn() },
  organizationChannel: { createMany: jest.fn() },
  organizationApplication: { update: jest.fn(), findUniqueOrThrow: jest.fn() },
  organizationApplicationOwner: { update: jest.fn() },
  organizationApplicationEvent: { createMany: jest.fn(), create: jest.fn() },
  organizationMember: { findFirst: jest.fn() },
};
const transactionMock = jest.fn(
  async (cb: (tx: unknown) => unknown) => cb(txFake),
);
const findOrganizationsMock = jest.fn();
const findOrganizationMock = jest.fn();
const emitOutboxMock = jest.fn();
const findByIdMock = jest.fn();
const findByIdWithOwnersMock = jest.fn();
const findByIdWithRelationsMock = jest.fn();
const lockForUpdateMock = jest.fn();
const searchMock = jest.fn();
const updateMock = jest.fn();
const recordEventMock = jest.fn();
const countDocumentsMock = jest.fn();
const rejectedEmailMock = jest.fn();
const needsInfoEmailMock = jest.fn();
const issueTrackingTokenMock = jest.fn();
const fetchOwnersMock = jest.fn();
const ensureUsersMock = jest.fn();
const lookupUsersMock = jest.fn();
const countOwnerOrgsMock = jest.fn();
const assertOwnerQuotaMock = jest.fn();
const grantMembershipMock = jest.fn();

jest.mock("../../../config/prisma.client", () => ({
  __esModule: true,
  default: {
    $transaction: (cb: never) => transactionMock(cb),
    organization: {
      findMany: (...a: unknown[]) => findOrganizationsMock(...a),
      findUnique: (...a: unknown[]) => findOrganizationMock(...a),
    },
  },
}));

jest.mock("../../../outbox/outbox.writer", () => ({
  emitOutbox: (...a: unknown[]) => emitOutboxMock(...a),
}));

jest.mock("../organization-application.repository", () => ({
  HIDDEN_FROM_ADMIN_STATUSES: ["DRAFT", "AWAITING_OWNER_CONFIRMATION"],
  organizationApplicationRepository: {
    findById: (...a: unknown[]) => findByIdMock(...a),
    findByIdWithOwners: (...a: unknown[]) => findByIdWithOwnersMock(...a),
    findByIdWithRelations: (...a: unknown[]) => findByIdWithRelationsMock(...a),
    lockForUpdate: (...a: unknown[]) => lockForUpdateMock(...a),
    search: (...a: unknown[]) => searchMock(...a),
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

jest.mock("../../organization/identity-user.client", () => ({
  fetchOrganizationOwnersByUserIds: (...a: unknown[]) => fetchOwnersMock(...a),
  getUserProfile: (m: Map<string, unknown>, id: string) =>
    m.get(id.toLowerCase().trim()),
}));

jest.mock("../identity-owner.client", () => ({
  IdentityUserStatus: { ACTIVE: 1, INACTIVE: 2, PENDING_ACTIVATION: 3 },
  ensureUsers: (...a: unknown[]) => ensureUsersMock(...a),
  lookupUsersByEmails: (...a: unknown[]) => lookupUsersMock(...a),
}));

jest.mock("../../organization/organization_member.repository", () => ({
  organizationMemberRepository: {
    countActiveOwnerOrgs: (...a: unknown[]) => countOwnerOrgsMock(...a),
  },
}));

jest.mock("../../organization/organization-membership.service", () => ({
  organizationMembershipService: {
    assertOwnerQuota: (...a: unknown[]) => assertOwnerQuotaMock(...a),
    grantMembership: (...a: unknown[]) => grantMembershipMock(...a),
  },
}));

import { organizationApplicationAdminService } from "../organization-application-admin.service";
import { HTTP_STATUS, HttpError } from "../../../constants/http-status";

const ADMIN = "admin-1";
type Row = Record<string, unknown>;

const owner = (overrides: Row = {}): Row => ({
  id: "c-an",
  applicationId: "app-1",
  email: "an@clb.vn",
  fullName: "Nguyen An",
  isLegalRep: true,
  nationalIdDocumentId: null,
  status: "CONFIRMED",
  confirmTokenHash: null,
  expiresAt: null,
  sentAt: null,
  sentCount: 0,
  respondedAt: new Date("2026-09-25T07:02:00Z"),
  declineReason: null,
  confirmIp: "14.161.0.1",
  confirmUa: "ua",
  resolvedUserId: null,
  removedAt: null,
  ...overrides,
});

const binh = (overrides: Row = {}) =>
  owner({
    id: "c-binh",
    email: "binh@gmail.com",
    fullName: "Tran Binh",
    isLegalRep: false,
    ...overrides,
  });

const application = (overrides: Row = {}): Row => ({
  id: "app-1",
  code: "ORG-ABCD1234",
  type: "NEW_ORG",
  orgType: "CLUB",
  status: "PENDING_REVIEW",
  submitterEmail: "an@clb.vn",
  contactEmail: "an@clb.vn",
  emailVerifiedAt: new Date(),
  profile: {
    name: "CLB Tình nguyện UIT",
    logoUrl: "https://res.cloudinary.com/demo/logo.png",
    address: "Thủ Đức",
  },
  channels: [{ type: "FACEBOOK_PAGE", url: "https://facebook.com/clbtn" }],
  lane: null,
  documentsWaived: false,
  documentsWaivedReason: null,
  legalRepIdType: null,
  legalRepIdLast4: null,
  legalRepPhone: null,
  legalRepPosition: null,
  submittedByUserId: null,
  consentedAt: new Date(),
  reviewerId: null,
  claimedAt: null,
  purgedAt: null,
  reviewNote: null,
  rejectReason: null,
  organizationId: null,
  createdAt: new Date(),
  submittedAt: new Date(),
  reviewedAt: null,
  owners: [owner(), binh()],
  ...overrides,
});

function useApplication(app: Row) {
  findByIdMock.mockResolvedValue(app);
  findByIdWithOwnersMock.mockResolvedValue(app);
  findByIdWithRelationsMock.mockResolvedValue({ ...app, documents: [], events: [] });
}

const users = new Map<string, Row>([
  ["an@clb.vn", { id: "u-an", email: "an@clb.vn", status: 1, createdAt: new Date() }],
  ["binh@gmail.com", { id: "u-binh", email: "binh@gmail.com", status: 3, createdAt: new Date() }],
]);

beforeEach(() => {
  jest.clearAllMocks();
  useApplication(application());
  countDocumentsMock.mockResolvedValue(1);
  findOrganizationsMock.mockResolvedValue([]);
  txFake.organization.create.mockResolvedValue({ id: "org-1" });
  txFake.organizationApplication.findUniqueOrThrow.mockResolvedValue({
    status: "PENDING_REVIEW",
  });
  ensureUsersMock.mockResolvedValue(users);
  lookupUsersMock.mockResolvedValue(new Map());
  countOwnerOrgsMock.mockResolvedValue(new Map());
  fetchOwnersMock.mockResolvedValue(new Map());
  assertOwnerQuotaMock.mockResolvedValue(undefined);
  grantMembershipMock.mockResolvedValue(undefined);
  updateMock.mockResolvedValue(undefined);
  recordEventMock.mockResolvedValue(undefined);
  rejectedEmailMock.mockResolvedValue(undefined);
  needsInfoEmailMock.mockResolvedValue(undefined);
  issueTrackingTokenMock.mockResolvedValue({ token: "track" });
});

describe("OrganizationApplicationAdminService.decide — duyệt", () => {
  const approve = (body: Row = {}) =>
    organizationApplicationAdminService.decide("app-1", ADMIN, {
      decision: "APPROVE",
      lane: "A",
      documentsWaived: true,
      documentsWaivedReason: "Email tên miền uit.edu.vn",
      ...body,
    } as never);

  it("lane A: tổ chức ACTIVE có tick, không còn ownerId, mọi thứ trong một transaction", async () => {
    await approve();

    const orgData = txFake.organization.create.mock.calls[0][0].data;
    expect(orgData).toMatchObject({
      status: 1,
      kycStatus: "APPROVED",
      trustTier: "VERIFIED",
      isEmailVerified: true,
    });
    expect(orgData).not.toHaveProperty("ownerId");
    expect(orgData.verificationExpiresAt).toBeNull();
    expect(lockForUpdateMock).toHaveBeenCalledWith(txFake, "app-1");
    expect(txFake.organizationApplication.update.mock.calls[0][0].data).toMatchObject({
      status: "APPROVED",
      organizationId: "org-1",
    });
  });

  it("tạo/lấy tài khoản cho từng owner trước transaction, gán vai theo isLegalRep", async () => {
    await approve();

    expect(ensureUsersMock).toHaveBeenCalledWith([
      { email: "an@clb.vn", fullName: "Nguyen An" },
      { email: "binh@gmail.com", fullName: "Tran Binh" },
    ]);
    expect(assertOwnerQuotaMock).toHaveBeenCalledWith(txFake, "u-an", "an@clb.vn");
    expect(assertOwnerQuotaMock).toHaveBeenCalledWith(txFake, "u-binh", "binh@gmail.com");
    expect(grantMembershipMock.mock.calls.map((c) => c[1])).toEqual([
      expect.objectContaining({
        userId: "u-an",
        organizationId: "org-1",
        role: "LEGAL_REPRESENTATIVE",
        source: "APPLICATION_APPROVAL",
        sourceRef: "app-1",
      }),
      expect.objectContaining({ userId: "u-binh", role: "OWNER" }),
    ]);
    expect(txFake.organizationApplicationOwner.update).toHaveBeenCalledWith({
      where: { id: "c-binh" },
      data: { resolvedUserId: "u-binh" },
    });
  });

  it("một outbox event gửi email cho mỗi owner, cùng transaction, khoá dedup theo candidate", async () => {
    await approve();

    expect(emitOutboxMock).toHaveBeenCalledTimes(2);
    for (const [tx] of emitOutboxMock.mock.calls) expect(tx).toBe(txFake);
    expect(emitOutboxMock.mock.calls.map((c) => c[1].dedupKey)).toEqual([
      "ORG_OWNER_ONBOARD:c-an",
      "ORG_OWNER_ONBOARD:c-binh",
    ]);
    expect(emitOutboxMock.mock.calls[1][1]).toMatchObject({
      eventType: "ORG_OWNER_ONBOARD",
      payload: {
        userId: "u-binh",
        email: "binh@gmail.com",
        organizationSlug: expect.any(String),
        isLegalRep: false,
      },
    });
  });

  it("owner có tài khoản bị đình chỉ thì không duyệt, không mở transaction", async () => {
    ensureUsersMock.mockResolvedValue(
      new Map<string, Row>([...users, ["binh@gmail.com", { id: "u-binh", status: 2 }]]),
    );

    await expect(approve()).rejects.toMatchObject({
      statusResponse: { code: "OWNER_SUSPENDED" },
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("vượt trần 3 tổ chức lúc duyệt thì cả transaction hỏng", async () => {
    assertOwnerQuotaMock.mockImplementation(async (_tx: unknown, userId: string) => {
      if (userId === "u-binh") throw new HttpError(HTTP_STATUS.OWNER_QUOTA_EXCEEDED);
    });

    await expect(approve()).rejects.toMatchObject({
      statusResponse: { code: "OWNER_QUOTA_EXCEEDED" },
    });
    expect(txFake.organizationApplication.update).not.toHaveBeenCalled();
  });

  it("phòng thủ chiều sâu: còn owner chưa xác nhận thì OWNERS_NOT_ALL_CONFIRMED", async () => {
    const pending = application({ owners: [owner(), binh({ status: "PENDING" })] });
    findByIdMock.mockResolvedValue(pending);
    findByIdWithOwnersMock.mockResolvedValue(pending);

    await expect(approve()).rejects.toMatchObject({
      statusResponse: { code: "OWNERS_NOT_ALL_CONFIRMED" },
    });
    expect(txFake.organization.create).not.toHaveBeenCalled();
  });

  it("hồ sơ đổi trạng thái giữa chừng (vừa bị trả về) thì NOT_PENDING_REVIEW", async () => {
    findByIdWithOwnersMock
      .mockResolvedValueOnce(application())
      .mockResolvedValueOnce(application({ status: "NEEDS_REVISION" }));

    await expect(approve()).rejects.toMatchObject({
      statusResponse: { code: "NOT_PENDING_REVIEW" },
    });
    expect(txFake.organization.create).not.toHaveBeenCalled();
  });

  it("hồ sơ đang chờ owner xác nhận thì admin không thấy (404)", async () => {
    useApplication(application({ status: "AWAITING_OWNER_CONFIRMATION" }));

    await expect(approve()).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_APPLICATION_NOT_FOUND" },
    });
  });

  it("hồ sơ đã có quyết định thì không xử lý lại", async () => {
    useApplication(application({ status: "APPROVED" }));

    await expect(approve()).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_APPLICATION_ALREADY_DECIDED" },
    });
  });

  it("lane B: chưa cấp tick và có hạn tái thẩm định 12 tháng", async () => {
    await approve({ lane: "B", documentsWaived: false, documentsWaivedReason: null });

    const orgData = txFake.organization.create.mock.calls[0][0].data;
    expect(orgData.trustTier).toBe("NONE");
    expect(orgData.verificationExpiresAt).toBeInstanceOf(Date);
  });

  it("email liên hệ khác hòm mail đã qua OTP thì chưa tính là đã xác thực", async () => {
    useApplication(application({ contactEmail: "contact@clb.vn" }));

    await approve();

    expect(txFake.organization.create.mock.calls[0][0].data.isEmailVerified).toBe(false);
  });

  it("miễn giấy tờ bắt buộc có lý do", async () => {
    await expect(approve({ documentsWaivedReason: "" })).rejects.toMatchObject({
      statusResponse: { code: "VALIDATION_ERROR" },
    });
  });

  it("không có giấy tờ và cũng không miễn thì không duyệt được", async () => {
    countDocumentsMock.mockResolvedValue(0);

    await expect(
      approve({ lane: "B", documentsWaived: false, documentsWaivedReason: null }),
    ).rejects.toMatchObject({ statusResponse: { status: 400 } });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("duyệt mà không chỉ định lane thì từ chối", async () => {
    await expect(approve({ lane: undefined })).rejects.toMatchObject({
      statusResponse: { status: 400 },
    });
  });
});

describe("OrganizationApplicationAdminService.decide — từ chối", () => {
  it("bắt buộc có lý do, không tạo tổ chức, mail tới người nộp", async () => {
    await expect(
      organizationApplicationAdminService.decide("app-1", ADMIN, { decision: "REJECT" }),
    ).rejects.toMatchObject({ statusResponse: { code: "VALIDATION_ERROR" } });

    await organizationApplicationAdminService.decide("app-1", ADMIN, {
      decision: "REJECT",
      rejectReason: "Giấy tờ không hợp lệ",
    });
    expect(txFake.organization.create).not.toHaveBeenCalled();
    expect(txFake.organizationApplication.update.mock.calls[0][0].data).toMatchObject({
      status: "REJECTED",
      rejectReason: "Giấy tờ không hợp lệ",
    });
    expect(rejectedEmailMock.mock.calls[0][0].toEmail).toBe("an@clb.vn");
  });
});

describe("OrganizationApplicationAdminService.claim", () => {
  it("hồ sơ người khác đang nhận thì không nhận được", async () => {
    useApplication(application({ reviewerId: "admin-2" }));

    await expect(
      organizationApplicationAdminService.claim("app-1", ADMIN),
    ).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_APPLICATION_CLAIMED" },
    });
  });

  it("nhận hồ sơ chỉ ghi người duyệt, trạng thái vẫn là PENDING_REVIEW", async () => {
    await organizationApplicationAdminService.claim("app-1", ADMIN);

    const data = updateMock.mock.calls[0][1];
    expect(data).toMatchObject({ reviewerId: ADMIN });
    expect(data).not.toHaveProperty("status");
  });
});

describe("OrganizationApplicationAdminService.requestMoreInfo", () => {
  it("chuyển sang NEEDS_REVISION, lưu note, mail tới người nộp kèm link theo dõi", async () => {
    await organizationApplicationAdminService.requestMoreInfo(
      "app-1",
      ADMIN,
      "Thiếu quyết định thành lập",
    );

    expect(updateMock.mock.calls[0][1]).toMatchObject({
      status: "NEEDS_REVISION",
      reviewerId: ADMIN,
      reviewNote: "Thiếu quyết định thành lập",
    });
    expect(recordEventMock.mock.calls[0][0]).toMatchObject({
      eventType: "INFO_REQUESTED",
      actorId: ADMIN,
    });
    expect(issueTrackingTokenMock).toHaveBeenCalledWith("an@clb.vn");
    expect(needsInfoEmailMock.mock.calls[0][0]).toMatchObject({ toEmail: "an@clb.vn" });
  });

  it("mail hỏng thì hồ sơ vẫn đổi trạng thái", async () => {
    needsInfoEmailMock.mockRejectedValue(new Error("notification-service down"));

    await expect(
      organizationApplicationAdminService.requestMoreInfo("app-1", ADMIN, "Bổ sung"),
    ).resolves.toBeDefined();
    expect(updateMock).toHaveBeenCalled();
  });

  it("hồ sơ đã bị trả về rồi thì không hỏi thêm được", async () => {
    useApplication(application({ status: "NEEDS_REVISION" }));

    await expect(
      organizationApplicationAdminService.requestMoreInfo("app-1", ADMIN, "Bổ sung"),
    ).rejects.toMatchObject({ statusResponse: { code: "NOT_PENDING_REVIEW" } });
    expect(needsInfoEmailMock).not.toHaveBeenCalled();
  });
});

describe("OrganizationApplicationAdminService.list", () => {
  it("không bao giờ trả hồ sơ nháp hoặc đang chờ owner xác nhận", async () => {
    searchMock.mockResolvedValue({ rows: [], total: 0 });

    await organizationApplicationAdminService.list({ page: 1, limit: 10 });

    expect(searchMock.mock.calls[0][0].excludeStatus).toEqual([
      "DRAFT",
      "AWAITING_OWNER_CONFIRMATION",
    ]);
  });
});

describe("OrganizationApplicationAdminService.getById — thẩm định con người", () => {
  it("mỗi owner kèm tài khoản, số org đang làm owner và cờ cùng IP trong 5 phút", async () => {
    useApplication(
      application({
        owners: [
          owner({ respondedAt: new Date("2026-09-25T07:00:00Z") }),
          binh({ respondedAt: new Date("2026-09-25T07:03:00Z") }),
          owner({
            id: "c-chi",
            email: "chi@gmail.com",
            isLegalRep: false,
            confirmIp: "1.2.3.4",
          }),
        ],
      }),
    );
    lookupUsersMock.mockResolvedValue(
      new Map([["an@clb.vn", { id: "u-an", status: 1, createdAt: new Date("2026-03-01") }]]),
    );
    countOwnerOrgsMock.mockResolvedValue(new Map([["u-an", 2]]));

    const result = await organizationApplicationAdminService.getById("app-1");

    const [an, b, chi] = result.owners;
    expect(an).toMatchObject({
      account: { userId: "u-an", status: 1 },
      activeOwnerOrgCount: 2,
      sameIpCluster: true,
      confirmIp: "14.161.0.1",
    });
    expect(b).toMatchObject({ account: null, activeOwnerOrgCount: 0, sameIpCluster: true });
    expect(chi.sameIpCluster).toBe(false);
  });

  it("identity hỏng thì vẫn trả hồ sơ, cột tài khoản để trống", async () => {
    lookupUsersMock.mockRejectedValue(new Error("identity down"));

    const result = await organizationApplicationAdminService.getById("app-1");

    expect(result.owners.every((o) => o.account === null)).toBe(true);
  });

  it("gắn tên người thao tác trong activity log", async () => {
    findByIdWithRelationsMock.mockResolvedValue({
      ...application(),
      documents: [],
      events: [
        { id: "ev-1", eventType: "CLAIMED", actorId: ADMIN, payload: {}, createdAt: new Date() },
        { id: "ev-2", eventType: "OWNER_CONFIRMED", actorId: null, payload: {}, createdAt: new Date() },
      ],
    });
    fetchOwnersMock.mockResolvedValue(
      new Map([[ADMIN, { id: ADMIN, name: "Admin Một", avatar: null, bio: null }]]),
    );

    const result = await organizationApplicationAdminService.getById("app-1");

    expect(result.events.map((e) => e.actorName)).toEqual(["Admin Một", null]);
  });

  it("hồ sơ nháp thì admin không mở được", async () => {
    useApplication(application({ status: "DRAFT" }));

    await expect(organizationApplicationAdminService.getById("app-1")).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_APPLICATION_NOT_FOUND" },
    });
  });
});

describe("OrganizationApplicationAdminService — duyệt đề xuất thêm owner (ADD_OWNER)", () => {
  const proposal = (overrides: Row = {}) =>
    application({
      type: "ADD_OWNER",
      organizationId: "org-1",
      lane: null,
      owners: [binh()],
      ...overrides,
    });

  beforeEach(() => {
    useApplication(proposal());
    findOrganizationMock.mockResolvedValue({
      id: "org-1",
      name: "CLB Xanh",
      slug: "clb-xanh",
      deletedAt: null,
    });
    txFake.organizationMember.findFirst.mockResolvedValue({ role: "MEMBER" });
    countDocumentsMock.mockResolvedValue(0);
  });

  it("không cần lane hay giấy tờ; nâng MEMBER lên OWNER, outbox cho từng người, không tạo tổ chức", async () => {
    await organizationApplicationAdminService.decide("app-1", ADMIN, {
      decision: "APPROVE",
    });

    expect(ensureUsersMock).toHaveBeenCalledWith([
      { email: "binh@gmail.com", fullName: "Tran Binh" },
    ]);
    expect(txFake.organization.create).not.toHaveBeenCalled();
    expect(assertOwnerQuotaMock).toHaveBeenCalledWith(txFake, "u-binh", "binh@gmail.com");
    expect(grantMembershipMock.mock.calls[0][1]).toMatchObject({
      userId: "u-binh",
      organizationId: "org-1",
      role: "OWNER",
      source: "APPLICATION_APPROVAL",
      sourceRef: "app-1",
    });
    expect(emitOutboxMock.mock.calls[0][1]).toMatchObject({
      eventType: "ORG_OWNER_ONBOARD",
      dedupKey: "ORG_OWNER_ONBOARD:c-binh",
      payload: expect.objectContaining({
        organizationSlug: "clb-xanh",
        userId: "u-binh",
        isLegalRep: false,
      }),
    });
    expect(txFake.organizationApplication.update.mock.calls[0][0].data).toMatchObject({
      status: "APPROVED",
      reviewerId: ADMIN,
    });
    expect(txFake.organizationApplicationEvent.create.mock.calls[0][0].data.payload).toMatchObject({
      type: "ADD_OWNER",
      ownerUserIds: ["u-binh"],
    });
  });

  it("người đó đã là owner từ trước: không cấp lại nhưng vẫn gửi email onboard", async () => {
    txFake.organizationMember.findFirst.mockResolvedValue({ role: "OWNER" });

    await organizationApplicationAdminService.decide("app-1", ADMIN, {
      decision: "APPROVE",
    });

    expect(grantMembershipMock).not.toHaveBeenCalled();
    expect(assertOwnerQuotaMock).not.toHaveBeenCalled();
    expect(emitOutboxMock).toHaveBeenCalledTimes(1);
  });

  it("vượt trần 3 tổ chức → lỗi, không cấp gì", async () => {
    assertOwnerQuotaMock.mockRejectedValue(new HttpError(HTTP_STATUS.OWNER_QUOTA_EXCEEDED));

    await expect(
      organizationApplicationAdminService.decide("app-1", ADMIN, { decision: "APPROVE" }),
    ).rejects.toMatchObject({ statusResponse: { code: "OWNER_QUOTA_EXCEEDED" } });
    expect(grantMembershipMock).not.toHaveBeenCalled();
  });

  it("có người chưa xác nhận (đọc lại trong transaction) → OWNERS_NOT_ALL_CONFIRMED", async () => {
    findByIdMock.mockResolvedValue(proposal());
    findByIdWithOwnersMock
      .mockResolvedValueOnce(proposal())
      .mockResolvedValueOnce(proposal({ owners: [binh({ status: "PENDING" })] }));

    await expect(
      organizationApplicationAdminService.decide("app-1", ADMIN, { decision: "APPROVE" }),
    ).rejects.toMatchObject({ statusResponse: { code: "OWNERS_NOT_ALL_CONFIRMED" } });
  });

  it("trạng thái đổi trong lúc duyệt → NOT_PENDING_REVIEW", async () => {
    findByIdMock.mockResolvedValue(proposal());
    findByIdWithOwnersMock
      .mockResolvedValueOnce(proposal())
      .mockResolvedValueOnce(proposal({ status: "WITHDRAWN" }));

    await expect(
      organizationApplicationAdminService.decide("app-1", ADMIN, { decision: "APPROVE" }),
    ).rejects.toMatchObject({ statusResponse: { code: "NOT_PENDING_REVIEW" } });
  });

  it("tổ chức đã bị xoá → CONFLICT, không gọi identity", async () => {
    findOrganizationMock.mockResolvedValue(null);

    await expect(
      organizationApplicationAdminService.decide("app-1", ADMIN, { decision: "APPROVE" }),
    ).rejects.toMatchObject({ statusResponse: { code: "CONFLICT" } });
    expect(ensureUsersMock).not.toHaveBeenCalled();
  });

  it("owner được đề xuất bị khoá tài khoản → OWNER_SUSPENDED", async () => {
    ensureUsersMock.mockResolvedValue(
      new Map([["binh@gmail.com", { id: "u-binh", email: "binh@gmail.com", status: 2 }]]),
    );

    await expect(
      organizationApplicationAdminService.decide("app-1", ADMIN, { decision: "APPROVE" }),
    ).rejects.toMatchObject({ statusResponse: { code: "OWNER_SUSPENDED" } });
  });

  it("đề xuất owner không trả về để sửa được → INVALID_INPUT", async () => {
    await expect(
      organizationApplicationAdminService.requestMoreInfo("app-1", ADMIN, "Bổ sung"),
    ).rejects.toMatchObject({ statusResponse: { code: "INVALID_INPUT" } });
    expect(updateMock).not.toHaveBeenCalled();
  });
});
