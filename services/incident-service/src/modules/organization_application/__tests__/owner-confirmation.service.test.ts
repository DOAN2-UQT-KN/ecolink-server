/**
 * Trang xác nhận công khai: sở hữu hòm mail là bằng chứng đồng thuận. Các nhánh cần chặt:
 * bấm lại link (idempotent), link hết hạn, hồ sơ đã rút, và việc chuyển sang PENDING_REVIEW
 * xảy ra ngay trong transaction của lần xác nhận cuối.
 */

const findCandidateByTokenHashMock = jest.fn();
const findOverdueCandidatesMock = jest.fn();
const findByIdWithOwnersMock = jest.fn();
const lockForUpdateMock = jest.fn();
const recordEventMock = jest.fn();
const issueTrackingTokenMock = jest.fn();
const declinedEmailMock = jest.fn();
const expiredEmailMock = jest.fn();
const orgFindUniqueMock = jest.fn();

const txFake = {
  organizationApplicationOwner: {
    findUniqueOrThrow: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
  },
  organizationApplication: { update: jest.fn() },
  ownerInviteBlock: { upsert: jest.fn() },
};
const transactionMock = jest.fn(
  async (cb: (tx: unknown) => unknown) => cb(txFake),
);

jest.mock("../../../config/prisma.client", () => ({
  __esModule: true,
  default: {
    $transaction: (cb: never) => transactionMock(cb),
    organization: { findUnique: (...a: unknown[]) => orgFindUniqueMock(...a) },
  },
}));

jest.mock("../organization-application.repository", () => ({
  organizationApplicationRepository: {
    findCandidateByTokenHash: (...a: unknown[]) => findCandidateByTokenHashMock(...a),
    findOverdueCandidates: (...a: unknown[]) => findOverdueCandidatesMock(...a),
    findByIdWithOwners: (...a: unknown[]) => findByIdWithOwnersMock(...a),
    lockForUpdate: (...a: unknown[]) => lockForUpdateMock(...a),
    recordEvent: (...a: unknown[]) => recordEventMock(...a),
  },
}));

jest.mock("../organization-application-otp.service", () => ({
  organizationApplicationOtpService: {
    issueTrackingToken: (...a: unknown[]) => issueTrackingTokenMock(...a),
  },
}));

jest.mock("../organization-application-notify.client", () => ({
  enqueueOwnerDeclinedEmail: (...a: unknown[]) => declinedEmailMock(...a),
  enqueueOwnerConfirmationExpiredEmail: (...a: unknown[]) => expiredEmailMock(...a),
}));

import { ownerConfirmationService } from "../owner-confirmation.service";
import { hashOpaqueToken } from "../../../utils/token-hash";

type Row = Record<string, unknown>;
const META = { ip: "14.161.0.9", userAgent: "Mozilla/5.0" };
const future = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

const app = (overrides: Row = {}): Row => ({
  id: "app-1",
  code: "ORG-1",
  status: "AWAITING_OWNER_CONFIRMATION",
  submitterEmail: "an@clb.vn",
  orgType: "CLUB",
  profile: { name: "CLB Xanh", address: "Thủ Đức" },
  owners: [],
  ...overrides,
});

const cand = (overrides: Row = {}, appOverrides: Row = {}): Row => ({
  id: "c-binh",
  applicationId: "app-1",
  email: "binh@gmail.com",
  fullName: "Tran Binh",
  isLegalRep: false,
  status: "PENDING",
  expiresAt: future(),
  removedAt: null,
  application: app(appOverrides),
  ...overrides,
});

/** Same row for the pre-transaction lookup and the locked re-read. */
function useCandidate(row: Row) {
  findCandidateByTokenHashMock.mockResolvedValue(row);
  txFake.organizationApplicationOwner.findUniqueOrThrow.mockResolvedValue(row);
}

beforeEach(() => {
  jest.clearAllMocks();
  recordEventMock.mockResolvedValue(undefined);
  issueTrackingTokenMock.mockResolvedValue({ token: "track" });
  declinedEmailMock.mockResolvedValue(undefined);
  expiredEmailMock.mockResolvedValue(undefined);
});

describe("OwnerConfirmationService.getSummary", () => {
  it("tra theo hash của token, trả tóm tắt và danh sách owner khác", async () => {
    useCandidate(
      cand(
        {},
        {
          owners: [
            { id: "c-an", email: "an@clb.vn", fullName: "An", isLegalRep: true },
            { id: "c-binh", email: "binh@gmail.com", fullName: "Binh", isLegalRep: false },
          ],
        },
      ),
    );

    const summary = await ownerConfirmationService.getSummary("raw-token");

    expect(findCandidateByTokenHashMock).toHaveBeenCalledWith(hashOpaqueToken("raw-token"));
    expect(summary).toMatchObject({
      active: true,
      expired: false,
      submitterEmail: "an@clb.vn",
      organization: { name: "CLB Xanh" },
      otherOwners: [{ email: "an@clb.vn", isLegalRep: true }],
      sessionEmailMismatch: false,
    });
  });

  it("đang đăng nhập bằng email khác thì cảnh báo, không im lặng", async () => {
    useCandidate(cand());

    const summary = await ownerConfirmationService.getSummary("t", "someone@else.vn");

    expect(summary.sessionEmailMismatch).toBe(true);
  });

  it("token không tồn tại thì 404", async () => {
    findCandidateByTokenHashMock.mockResolvedValue(null);

    await expect(ownerConfirmationService.getSummary("nope")).rejects.toMatchObject({
      statusResponse: { code: "OWNER_CONFIRMATION_NOT_FOUND" },
    });
  });
});

describe("OwnerConfirmationService.confirm", () => {
  it("xác nhận: lưu IP + UA làm bằng chứng, còn người chưa trả lời thì hồ sơ vẫn chờ", async () => {
    useCandidate(cand());
    txFake.organizationApplicationOwner.count.mockResolvedValue(1);

    const result = await ownerConfirmationService.confirm("t", META);

    expect(lockForUpdateMock).toHaveBeenCalledWith(txFake, "app-1");
    expect(txFake.organizationApplicationOwner.update.mock.calls[0][0].data).toMatchObject({
      status: "CONFIRMED",
      confirmIp: META.ip,
      confirmUa: META.userAgent,
    });
    expect(result).toMatchObject({ alreadyDone: false, remaining: 1 });
    expect(txFake.organizationApplication.update).not.toHaveBeenCalled();
    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "OWNER_CONFIRMED" }),
    );
  });

  it("người cuối cùng xác nhận → PENDING_REVIEW ngay trong cùng transaction", async () => {
    useCandidate(cand());
    txFake.organizationApplicationOwner.count.mockResolvedValue(0);

    const result = await ownerConfirmationService.confirm("t", META);

    expect(result.applicationStatus).toBe("PENDING_REVIEW");
    expect(txFake.organizationApplication.update.mock.calls[0][0].data.status).toBe(
      "PENDING_REVIEW",
    );
    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "READY_FOR_REVIEW" }),
    );
  });

  it("đủ chữ ký nhưng người nộp đang sửa hồ sơ (NEEDS_REVISION) thì chưa vào hàng chờ", async () => {
    useCandidate(cand({}, { status: "NEEDS_REVISION" }));
    txFake.organizationApplicationOwner.count.mockResolvedValue(0);

    const result = await ownerConfirmationService.confirm("t", META);

    expect(result.applicationStatus).toBe("NEEDS_REVISION");
    expect(txFake.organizationApplication.update).not.toHaveBeenCalled();
  });

  it("bấm lại link đã xác nhận: idempotent, không ghi gì thêm", async () => {
    useCandidate(cand({ status: "CONFIRMED" }));

    const result = await ownerConfirmationService.confirm("t", META);

    expect(result.alreadyDone).toBe(true);
    expect(txFake.organizationApplicationOwner.update).not.toHaveBeenCalled();
  });

  it("đã từ chối thì không xác nhận được nữa", async () => {
    useCandidate(cand({ status: "DECLINED" }));

    await expect(ownerConfirmationService.confirm("t", META)).rejects.toMatchObject({
      statusResponse: { code: "ALREADY_DECLINED" },
    });
  });

  it("link hết hạn → 410 CONFIRM_EXPIRED", async () => {
    useCandidate(cand({ expiresAt: new Date(Date.now() - 1000) }));

    await expect(ownerConfirmationService.confirm("t", META)).rejects.toMatchObject({
      statusResponse: { status: 410, code: "CONFIRM_EXPIRED" },
    });
    expect(txFake.organizationApplicationOwner.update).not.toHaveBeenCalled();
  });

  it("hồ sơ đã rút → APPLICATION_NOT_ACTIVE (báo đúng lý do, không phải 'hết hạn')", async () => {
    // Rút hồ sơ đặt expiresAt = now cho link chưa dùng; lý do hiển thị vẫn phải là "đã rút".
    useCandidate(cand({ expiresAt: new Date(Date.now() - 1000) }, { status: "WITHDRAWN" }));

    await expect(ownerConfirmationService.confirm("t", META)).rejects.toMatchObject({
      statusResponse: { code: "APPLICATION_NOT_ACTIVE" },
    });
  });

  it("candidate đã bị gỡ khỏi danh sách thì link không còn giá trị", async () => {
    findCandidateByTokenHashMock.mockResolvedValue(cand({ removedAt: new Date() }));

    await expect(ownerConfirmationService.confirm("t", META)).rejects.toMatchObject({
      statusResponse: { code: "OWNER_CONFIRMATION_NOT_FOUND" },
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

describe("OwnerConfirmationService.decline", () => {
  it("'Tôi không liên quan': hồ sơ về NEEDS_REVISION, báo người nộp", async () => {
    useCandidate(cand());

    const result = await ownerConfirmationService.decline("t", { reason: "Gõ nhầm email" });
    // The submitter email goes out after the link is resolved (async).
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.applicationStatus).toBe("NEEDS_REVISION");
    expect(txFake.organizationApplicationOwner.update.mock.calls[0][0].data).toMatchObject({
      status: "DECLINED",
      declineReason: "Gõ nhầm email",
    });
    expect(txFake.organizationApplication.update.mock.calls[0][0].data).toMatchObject({
      status: "NEEDS_REVISION",
      reviewNote: expect.stringContaining("binh@gmail.com"),
    });
    expect(txFake.ownerInviteBlock.upsert).not.toHaveBeenCalled();
    expect(declinedEmailMock.mock.calls[0][0]).toMatchObject({
      toEmail: "an@clb.vn",
      ownerEmail: "binh@gmail.com",
    });
  });

  it("chọn chặn lời mời tương lai thì ghi vào danh sách chặn", async () => {
    useCandidate(cand());

    await ownerConfirmationService.decline("t", { blockFuture: true });

    expect(txFake.ownerInviteBlock.upsert.mock.calls[0][0]).toMatchObject({
      where: { email: "binh@gmail.com" },
    });
  });

  it("đã xác nhận rồi thì không từ chối được", async () => {
    useCandidate(cand({ status: "CONFIRMED" }));

    await expect(ownerConfirmationService.decline("t", {})).rejects.toMatchObject({
      statusResponse: { code: "ALREADY_CONFIRMED" },
    });
  });

  it("bấm từ chối lần hai: không đổi gì, không gửi mail lại", async () => {
    useCandidate(cand({ status: "DECLINED" }));

    await ownerConfirmationService.decline("t", {});

    expect(txFake.organizationApplication.update).not.toHaveBeenCalled();
    expect(declinedEmailMock).not.toHaveBeenCalled();
  });
});

describe("OwnerConfirmationService.expireOverdue", () => {
  it("candidate quá 14 ngày → EXPIRED, hồ sơ về NEEDS_REVISION, báo người nộp", async () => {
    findOverdueCandidatesMock.mockResolvedValue([{ applicationId: "app-1" }]);
    findByIdWithOwnersMock.mockResolvedValue(
      app({
        owners: [
          { id: "c-an", email: "an@clb.vn", status: "CONFIRMED", expiresAt: null },
          {
            id: "c-binh",
            email: "binh@gmail.com",
            status: "PENDING",
            expiresAt: new Date(Date.now() - 1000),
          },
        ],
      }),
    );

    const count = await ownerConfirmationService.expireOverdue();

    expect(count).toBe(1);
    expect(txFake.organizationApplicationOwner.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: { in: ["c-binh"] } },
      data: { status: "EXPIRED" },
    });
    expect(txFake.organizationApplication.update.mock.calls[0][0].data.status).toBe(
      "NEEDS_REVISION",
    );
    expect(expiredEmailMock.mock.calls[0][0]).toMatchObject({
      toEmail: "an@clb.vn",
      ownerEmails: "binh@gmail.com",
    });
  });

  it("xác nhận đã về đích trước khi quét thì bỏ qua", async () => {
    findOverdueCandidatesMock.mockResolvedValue([{ applicationId: "app-1" }]);
    findByIdWithOwnersMock.mockResolvedValue(app({ status: "PENDING_REVIEW" }));

    const count = await ownerConfirmationService.expireOverdue();

    expect(count).toBe(0);
    expect(txFake.organizationApplication.update).not.toHaveBeenCalled();
    expect(expiredEmailMock).not.toHaveBeenCalled();
  });
});

describe("OwnerConfirmationService — đề xuất thêm owner (ADD_OWNER)", () => {
  const addOwner = { type: "ADD_OWNER", organizationId: "org-1" };

  it("owner được đề xuất từ chối → huỷ đề xuất (WITHDRAWN), link email về trang tổ chức", async () => {
    orgFindUniqueMock.mockResolvedValue({ slug: "clb-xanh" });
    useCandidate(cand({}, addOwner));

    const result = await ownerConfirmationService.decline("t", { reason: "Không liên quan" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.applicationStatus).toBe("WITHDRAWN");
    expect(txFake.organizationApplication.update.mock.calls[0][0].data.status).toBe(
      "WITHDRAWN",
    );
    expect(issueTrackingTokenMock).not.toHaveBeenCalled();
    expect(declinedEmailMock.mock.calls[0][0].trackUrl).toContain("/organizations/clb-xanh");
  });

  it("hết hạn xác nhận → huỷ đề xuất (WITHDRAWN), không phải NEEDS_REVISION", async () => {
    orgFindUniqueMock.mockResolvedValue({ slug: "clb-xanh" });
    findOverdueCandidatesMock.mockResolvedValue([{ applicationId: "app-1" }]);
    findByIdWithOwnersMock.mockResolvedValue(
      app({
        ...addOwner,
        owners: [
          {
            id: "c-binh",
            email: "binh@gmail.com",
            status: "PENDING",
            expiresAt: new Date(Date.now() - 1000),
          },
        ],
      }),
    );

    const count = await ownerConfirmationService.expireOverdue();

    expect(count).toBe(1);
    expect(txFake.organizationApplication.update.mock.calls[0][0].data.status).toBe(
      "WITHDRAWN",
    );
    expect(expiredEmailMock.mock.calls[0][0].trackUrl).toContain("/organizations/clb-xanh");
  });

  it("tóm tắt trả về loại hồ sơ để trang xác nhận đổi lời dẫn", async () => {
    useCandidate(cand({}, addOwner));

    const summary = await ownerConfirmationService.getSummary("t");

    expect(summary.applicationType).toBe("ADD_OWNER");
  });
});
