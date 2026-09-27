/**
 * ADD_OWNER: một owner đề xuất thêm owner. Cùng đảm bảo như đăng ký mới — ai được đề xuất
 * cũng phải tự xác nhận qua email, rồi admin nền tảng duyệt — nhưng không có hồ sơ để điền.
 */

const findActiveRoleMock = jest.fn();
const orgFindByIdMock = jest.fn();
const lookupUsersByIdsMock = jest.fn();
const lookupUsersByEmailsMock = jest.fn();
const withdrawnNoticeMock = jest.fn();
const recordEventMock = jest.fn();
const lockForUpdateMock = jest.fn();
const findByIdWithOwnersMock = jest.fn();
const appFindByIdMock = jest.fn();
const assertOwnersEligibleMock = jest.fn();
const createWithUniqueCodeMock = jest.fn();
const resendCandidateMock = jest.fn();
const sendConfirmationEmailsMock = jest.fn();

const applicationModel = { findFirst: jest.fn(), findMany: jest.fn() };
const txFake = {
  organizationApplicationOwner: {
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  organizationApplication: { update: jest.fn() },
};
const transactionMock = jest.fn(async (cb: (tx: unknown) => unknown) => cb(txFake));

jest.mock("../../../config/prisma.client", () => ({
  __esModule: true,
  default: {
    $transaction: (cb: never) => transactionMock(cb),
    organizationApplication: applicationModel,
  },
}));

jest.mock("../../organization/organization_member.repository", () => ({
  organizationMemberRepository: {
    findActiveRole: (...a: unknown[]) => findActiveRoleMock(...a),
  },
}));

jest.mock("../../organization/organization.repository", () => ({
  organizationRepository: { findById: (...a: unknown[]) => orgFindByIdMock(...a) },
}));

jest.mock("../identity-owner.client", () => ({
  lookupUsersByIds: (...a: unknown[]) => lookupUsersByIdsMock(...a),
  lookupUsersByEmails: (...a: unknown[]) => lookupUsersByEmailsMock(...a),
}));

jest.mock("../organization-application-notify.client", () => ({
  enqueueApplicationWithdrawnNoticeEmail: (...a: unknown[]) => withdrawnNoticeMock(...a),
}));

jest.mock("../organization-application.repository", () => ({
  organizationApplicationRepository: {
    recordEvent: (...a: unknown[]) => recordEventMock(...a),
    lockForUpdate: (...a: unknown[]) => lockForUpdateMock(...a),
    findByIdWithOwners: (...a: unknown[]) => findByIdWithOwnersMock(...a),
    findById: (...a: unknown[]) => appFindByIdMock(...a),
  },
}));

jest.mock("../organization-application.service", () => ({
  organizationApplicationService: {
    assertOwnersEligible: (...a: unknown[]) => assertOwnersEligibleMock(...a),
    createWithUniqueCode: (...a: unknown[]) => createWithUniqueCodeMock(...a),
    resendCandidate: (...a: unknown[]) => resendCandidateMock(...a),
  },
}));

jest.mock("../owner-candidates", () => ({
  ...jest.requireActual("../owner-candidates"),
  sendConfirmationEmails: (...a: unknown[]) => sendConfirmationEmailsMock(...a),
}));

import { ownerProposalService } from "../owner-proposal.service";

const ORG = "org-1";
const OWNER = "u-owner";

function roles(map: Record<string, string | null>) {
  findActiveRoleMock.mockImplementation(async (_org: string, userId: string) =>
    userId in map ? map[userId] : null,
  );
}

type Row = Record<string, unknown>;
const candidateRow = (overrides: Row = {}): Row => ({
  id: "c-binh",
  applicationId: "app-9",
  email: "binh@gmail.com",
  fullName: "Tran Binh",
  isLegalRep: false,
  nationalIdDocumentId: null,
  status: "PENDING",
  sentAt: null,
  sentCount: 0,
  expiresAt: null,
  respondedAt: null,
  declineReason: null,
  removedAt: null,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  orgFindByIdMock.mockResolvedValue({
    id: ORG,
    name: "CLB Xanh",
    slug: "clb-xanh",
    logoUrl: "https://x/logo.png",
    address: "Thủ Đức",
    contactEmail: "lienhe@clb.vn",
    orgType: "CLUB",
  });
  applicationModel.findFirst.mockResolvedValue(null);
  lookupUsersByIdsMock.mockResolvedValue(new Map());
  lookupUsersByEmailsMock.mockResolvedValue(new Map());
  assertOwnersEligibleMock.mockResolvedValue(undefined);
  createWithUniqueCodeMock.mockResolvedValue({ id: "app-9", code: "ORG-9" });
  txFake.organizationApplicationOwner.findMany.mockResolvedValue([candidateRow()]);
  txFake.organizationApplicationOwner.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Row }) =>
      candidateRow({ id: where.id, confirmTokenHash: data.confirmTokenHash, sentCount: 1 }),
  );
  applicationModel.findMany.mockResolvedValue([
    {
      id: "app-9",
      code: "ORG-9",
      status: "AWAITING_OWNER_CONFIRMATION",
      profile: { proposalReason: "Mở rộng ban điều hành" },
      reviewNote: null,
      rejectReason: null,
      submitterEmail: "an@clb.vn",
      owners: [candidateRow()],
      createdAt: new Date(),
      submittedAt: new Date(),
      reviewedAt: null,
    },
  ]);
  recordEventMock.mockResolvedValue(undefined);
  withdrawnNoticeMock.mockResolvedValue(undefined);
});

describe("OwnerProposalService.create", () => {
  it("owner đề xuất bằng email: tạo hồ sơ ADD_OWNER, gửi link xác nhận cho từng người", async () => {
    roles({ [OWNER]: "OWNER" });

    const proposal = await ownerProposalService.create(
      ORG,
      OWNER,
      "An@Clb.vn",
      [{ email: "Binh@Gmail.com", fullName: "Tran Binh" }],
      "Mở rộng ban điều hành",
    );

    const data = createWithUniqueCodeMock.mock.calls[0][0];
    expect(data).toMatchObject({
      type: "ADD_OWNER",
      status: "AWAITING_OWNER_CONFIRMATION",
      organizationId: ORG,
      submitterEmail: "an@clb.vn",
      submittedByUserId: OWNER,
      orgType: "CLUB",
      profile: expect.objectContaining({
        name: "CLB Xanh",
        proposalReason: "Mở rộng ban điều hành",
      }),
      owners: {
        create: [{ email: "binh@gmail.com", fullName: "Tran Binh", isLegalRep: false }],
      },
    });
    // Không đi qua back-relation `organization` (sẽ trỏ lại application_id của tổ chức).
    expect(data.organization).toBeUndefined();

    const tokenUpdate = txFake.organizationApplicationOwner.update.mock.calls[0][0].data;
    expect(tokenUpdate.confirmTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(sendConfirmationEmailsMock.mock.calls[0][0]).toMatchObject({
      isAddOwner: true,
      submitterEmail: "An@Clb.vn",
    });
    expect(sendConfirmationEmailsMock.mock.calls[0][0].issued).toHaveLength(1);
    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "SUBMITTED",
        payload: expect.objectContaining({ type: "ADD_OWNER" }),
      }),
    );
    expect(proposal).toMatchObject({ id: "app-9", reason: "Mở rộng ban điều hành" });
  });

  it("chọn tài khoản có sẵn: lấy email từ identity theo userId", async () => {
    roles({ [OWNER]: "OWNER" });
    lookupUsersByIdsMock.mockResolvedValue(
      new Map([["u-binh", { id: "u-binh", email: "binh@gmail.com", name: "Binh", status: 1 }]]),
    );

    await ownerProposalService.create(ORG, OWNER, "an@clb.vn", [
      { userId: "u-binh", fullName: "" },
    ], null);

    expect(lookupUsersByIdsMock).toHaveBeenCalledWith(["u-binh"]);
    expect(createWithUniqueCodeMock.mock.calls[0][0].owners.create[0]).toMatchObject({
      email: "binh@gmail.com",
      fullName: "Binh",
    });
  });

  it("userId không tồn tại → INVITEE_NOT_AVAILABLE", async () => {
    roles({ [OWNER]: "OWNER" });

    await expect(
      ownerProposalService.create(ORG, OWNER, "an@clb.vn", [{ userId: "u-x", fullName: "X" }], null),
    ).rejects.toMatchObject({ statusResponse: { code: "INVITEE_NOT_AVAILABLE" } });
  });

  it("admin không được đề xuất owner → ORG_PERMISSION_DENIED", async () => {
    roles({ "u-admin": "ADMIN" });

    await expect(
      ownerProposalService.create(ORG, "u-admin", "ad@clb.vn", [
        { email: "binh@gmail.com", fullName: "Binh" },
      ], null),
    ).rejects.toMatchObject({ statusResponse: { code: "ORG_PERMISSION_DENIED" } });
    expect(createWithUniqueCodeMock).not.toHaveBeenCalled();
  });

  it("đã có một đề xuất đang mở → OWNER_PROPOSAL_ALREADY_OPEN", async () => {
    roles({ [OWNER]: "OWNER" });
    applicationModel.findFirst.mockResolvedValue({ id: "app-open" });

    await expect(
      ownerProposalService.create(ORG, OWNER, "an@clb.vn", [
        { email: "binh@gmail.com", fullName: "Binh" },
      ], null),
    ).rejects.toMatchObject({ statusResponse: { code: "OWNER_PROPOSAL_ALREADY_OPEN" } });
  });

  it("người được đề xuất đã là owner → ALREADY_OWNER", async () => {
    roles({ [OWNER]: "OWNER", "u-binh": "LEGAL_REPRESENTATIVE" });
    lookupUsersByEmailsMock.mockResolvedValue(
      new Map([["binh@gmail.com", { id: "u-binh", email: "binh@gmail.com", status: 1 }]]),
    );

    await expect(
      ownerProposalService.create(ORG, OWNER, "an@clb.vn", [
        { email: "binh@gmail.com", fullName: "Binh" },
      ], null),
    ).rejects.toMatchObject({ statusResponse: { code: "ALREADY_OWNER" } });
  });

  it("member thường thì được đề xuất lên owner; vẫn chạy kiểm tra chặn sớm", async () => {
    roles({ [OWNER]: "OWNER", "u-binh": "MEMBER" });
    lookupUsersByEmailsMock.mockResolvedValue(
      new Map([["binh@gmail.com", { id: "u-binh", email: "binh@gmail.com", status: 1 }]]),
    );

    await ownerProposalService.create(ORG, OWNER, "an@clb.vn", [
      { email: "binh@gmail.com", fullName: "Binh" },
    ], null);

    expect(assertOwnersEligibleMock).toHaveBeenCalledWith(
      expect.any(String),
      "an@clb.vn",
      [expect.objectContaining({ email: "binh@gmail.com" })],
    );
    expect(createWithUniqueCodeMock).toHaveBeenCalled();
  });
});

describe("OwnerProposalService.cancel / resend / list", () => {
  const openProposal = (overrides: Row = {}): Row => ({
    id: "app-9",
    code: "ORG-9",
    type: "ADD_OWNER",
    organizationId: ORG,
    status: "AWAITING_OWNER_CONFIRMATION",
    submitterEmail: "an@clb.vn",
    profile: { name: "CLB Xanh" },
    owners: [
      candidateRow({ id: "c-binh", status: "CONFIRMED" }),
      candidateRow({ id: "c-chi", email: "chi@gmail.com", status: "PENDING" }),
    ],
    ...overrides,
  });

  it("huỷ đề xuất → WITHDRAWN, vô hiệu link chưa dùng, báo người đã xác nhận", async () => {
    roles({ [OWNER]: "OWNER" });
    findByIdWithOwnersMock.mockResolvedValue(openProposal());

    await ownerProposalService.cancel(ORG, "app-9", OWNER);

    expect(txFake.organizationApplication.update.mock.calls[0][0].data.status).toBe(
      "WITHDRAWN",
    );
    expect(txFake.organizationApplicationOwner.updateMany.mock.calls[0][0]).toMatchObject({
      where: { applicationId: "app-9", status: "PENDING" },
    });
    expect(withdrawnNoticeMock).toHaveBeenCalledTimes(1);
    expect(withdrawnNoticeMock.mock.calls[0][0].toEmail).toBe("binh@gmail.com");
  });

  it("đề xuất của tổ chức khác → ORGANIZATION_APPLICATION_NOT_FOUND", async () => {
    roles({ [OWNER]: "OWNER" });
    findByIdWithOwnersMock.mockResolvedValue(openProposal({ organizationId: "org-2" }));

    await expect(ownerProposalService.cancel(ORG, "app-9", OWNER)).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_APPLICATION_NOT_FOUND" },
    });
  });

  it("đề xuất đã được duyệt thì không huỷ được", async () => {
    roles({ [OWNER]: "OWNER" });
    findByIdWithOwnersMock.mockResolvedValue(openProposal({ status: "APPROVED" }));

    await expect(ownerProposalService.cancel(ORG, "app-9", OWNER)).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_APPLICATION_ALREADY_DECIDED" },
    });
  });

  it("gửi lại link: kiểm đúng tổ chức và loại hồ sơ rồi uỷ cho resendCandidate", async () => {
    roles({ [OWNER]: "OWNER" });
    appFindByIdMock.mockResolvedValue(openProposal());

    await ownerProposalService.resend(ORG, "app-9", "c-chi", OWNER);

    expect(resendCandidateMock).toHaveBeenCalledWith("app-9", "c-chi");
  });

  it("gửi lại cho hồ sơ NEW_ORG qua đường này → ORGANIZATION_APPLICATION_NOT_FOUND", async () => {
    roles({ [OWNER]: "OWNER" });
    appFindByIdMock.mockResolvedValue(openProposal({ type: "NEW_ORG" }));

    await expect(
      ownerProposalService.resend(ORG, "app-9", "c-chi", OWNER),
    ).rejects.toMatchObject({ statusResponse: { code: "ORGANIZATION_APPLICATION_NOT_FOUND" } });
    expect(resendCandidateMock).not.toHaveBeenCalled();
  });

  it("danh sách: chỉ owner xem được, kèm lý do và số người đã xác nhận", async () => {
    roles({ [OWNER]: "OWNER", "u-member": "MEMBER" });

    const list = await ownerProposalService.list(ORG, OWNER);
    expect(list[0]).toMatchObject({ reason: "Mở rộng ban điều hành", confirmedCount: 0 });
    expect(applicationModel.findMany.mock.calls[0][0].where).toMatchObject({
      type: "ADD_OWNER",
      organizationId: ORG,
    });

    await expect(ownerProposalService.list(ORG, "u-member")).rejects.toMatchObject({
      statusResponse: { code: "ORG_PERMISSION_DENIED" },
    });
  });
});
