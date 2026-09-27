/**
 * Luồng nộp hồ sơ nhiều owner: bản nháp mở ngay sau OTP, kiểm tra chặn sớm TRƯỚC khi gửi bất
 * kỳ email nào, người nộp tự xác nhận, và quy tắc reset xác nhận khi đổi những thứ owner đã
 * đồng ý.
 */

const findOpenBySubmitterEmailMock = jest.fn();
const findByIdMock = jest.fn();
const findByIdWithOwnersMock = jest.fn();
const findByIdWithRelationsMock = jest.fn();
const lockForUpdateMock = jest.fn();
const createMock = jest.fn();
const recordEventMock = jest.fn();
const countOtherCandidaciesMock = jest.fn();
const findBlockedEmailsMock = jest.fn();
const findDocumentsByIdsMock = jest.fn();
const countUnattachedDocumentsMock = jest.fn();
const createDocumentMock = jest.fn();
const findDocumentByIdMock = jest.fn();
const issueTrackingTokenMock = jest.fn();
const draftStartedEmailMock = jest.fn();
const draftUpdatedEmailMock = jest.fn();
const findLatestEventMock = jest.fn();
const resolveTrackingTokenMock = jest.fn();
const receivedEmailMock = jest.fn();
const confirmationEmailMock = jest.fn();
const withdrawnNoticeMock = jest.fn();
const lookupUsersMock = jest.fn();
const countOwnerOrgsMock = jest.fn();
const createSignedUploadMock = jest.fn();
const downloadMock = jest.fn();

const txFake = {
  organizationApplication: {
    update: jest.fn(),
    findUniqueOrThrow: jest.fn(),
  },
  organizationApplicationOwner: {
    update: jest.fn(),
    updateMany: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  organizationApplicationDocument: { updateMany: jest.fn() },
};
const transactionMock = jest.fn(
  async (cb: (tx: unknown) => unknown) => cb(txFake),
);

jest.mock("../../../config/prisma.client", () => ({
  __esModule: true,
  default: { $transaction: (cb: never) => transactionMock(cb) },
}));

jest.mock("../organization-application.repository", () => ({
  organizationApplicationRepository: {
    findOpenBySubmitterEmail: (...a: unknown[]) => findOpenBySubmitterEmailMock(...a),
    findById: (...a: unknown[]) => findByIdMock(...a),
    findByIdWithOwners: (...a: unknown[]) => findByIdWithOwnersMock(...a),
    findByIdWithRelations: (...a: unknown[]) => findByIdWithRelationsMock(...a),
    lockForUpdate: (...a: unknown[]) => lockForUpdateMock(...a),
    create: (...a: unknown[]) => createMock(...a),
    recordEvent: (...a: unknown[]) => recordEventMock(...a),
    findLatestEvent: (...a: unknown[]) => findLatestEventMock(...a),
    countOtherCandidacies: (...a: unknown[]) => countOtherCandidaciesMock(...a),
    findBlockedEmails: (...a: unknown[]) => findBlockedEmailsMock(...a),
    findDocumentsByIds: (...a: unknown[]) => findDocumentsByIdsMock(...a),
    countUnattachedDocuments: (...a: unknown[]) => countUnattachedDocumentsMock(...a),
    createDocument: (...a: unknown[]) => createDocumentMock(...a),
    findDocumentById: (...a: unknown[]) => findDocumentByIdMock(...a),
  },
}));

jest.mock("../organization-application-otp.service", () => ({
  organizationApplicationOtpService: {
    issueTrackingToken: (...a: unknown[]) => issueTrackingTokenMock(...a),
    resolveTrackingToken: (...a: unknown[]) => resolveTrackingTokenMock(...a),
  },
}));

jest.mock("../organization-application-notify.client", () => ({
  enqueueApplicationReceivedEmail: (...a: unknown[]) => receivedEmailMock(...a),
  enqueueApplicationDraftStartedEmail: (...a: unknown[]) =>
    draftStartedEmailMock(...a),
  enqueueApplicationDraftUpdatedEmail: (...a: unknown[]) =>
    draftUpdatedEmailMock(...a),
  enqueueOwnerConfirmationRequestEmail: (...a: unknown[]) =>
    confirmationEmailMock(...a),
  enqueueApplicationWithdrawnNoticeEmail: (...a: unknown[]) =>
    withdrawnNoticeMock(...a),
}));

jest.mock("../identity-owner.client", () => ({
  IdentityUserStatus: { ACTIVE: 1, INACTIVE: 2, PENDING_ACTIVATION: 3 },
  lookupUsersByEmails: (...a: unknown[]) => lookupUsersMock(...a),
}));

jest.mock("../../organization/organization_member.repository", () => ({
  organizationMemberRepository: {
    countActiveOwnerOrgs: (...a: unknown[]) => countOwnerOrgsMock(...a),
  },
}));

jest.mock("../storage/cloudinary-document-storage", () => ({
  documentStorage: {
    createSignedUpload: (...a: unknown[]) => createSignedUploadMock(...a),
    download: (...a: unknown[]) => downloadMock(...a),
  },
}));

import { organizationApplicationService } from "../organization-application.service";
import { buildConfirmationSnapshot, validateOwnerList } from "../owner-candidates";
import { hashOpaqueToken } from "../../../utils/token-hash";

const SUBMITTER = "an@clb.vn";
const META = { ip: "14.161.0.1", userAgent: "jest" };

type Row = Record<string, unknown>;

const candidate = (overrides: Row = {}): Row => ({
  id: "c-an",
  applicationId: "app-1",
  email: SUBMITTER,
  fullName: "Nguyen An",
  isLegalRep: true,
  nationalIdDocumentId: null,
  status: "PENDING",
  confirmTokenHash: null,
  expiresAt: null,
  sentAt: null,
  sentCount: 0,
  respondedAt: null,
  declineReason: null,
  confirmIp: null,
  confirmUa: null,
  resolvedUserId: null,
  removedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const binh = (overrides: Row = {}) =>
  candidate({
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
  status: "DRAFT",
  submitterEmail: SUBMITTER,
  contactEmail: SUBMITTER,
  profile: {
    name: "CLB Tình nguyện UIT",
    logoUrl: "https://res.cloudinary.com/demo/logo.png",
    description: "Dọn rác cuối tuần",
  },
  channels: [{ type: "FACEBOOK_PAGE", url: "https://facebook.com/clbtn" }],
  legalRepPhone: null,
  legalRepPosition: null,
  legalRepIdType: null,
  legalRepIdHash: null,
  legalRepIdLast4: null,
  consentedAt: new Date(),
  confirmationSnapshot: null,
  reviewNote: null,
  rejectReason: null,
  organizationId: null,
  createdAt: new Date(),
  submittedAt: null,
  reviewedAt: null,
  owners: [candidate(), binh()],
  ...overrides,
});

/** Wires every lookup the service does to one application row. */
function useApplication(app: Row) {
  findByIdMock.mockResolvedValue(app);
  findByIdWithOwnersMock.mockResolvedValue(app);
  findByIdWithRelationsMock.mockResolvedValue({ ...app, documents: [], events: [] });
}

beforeEach(() => {
  jest.clearAllMocks();
  resolveTrackingTokenMock.mockResolvedValue(SUBMITTER);
  issueTrackingTokenMock.mockResolvedValue({
    token: "track-new",
    expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
  });
  draftStartedEmailMock.mockResolvedValue(undefined);
  draftUpdatedEmailMock.mockResolvedValue(undefined);
  findLatestEventMock.mockResolvedValue(null);
  lookupUsersMock.mockResolvedValue(new Map());
  countOwnerOrgsMock.mockResolvedValue(new Map());
  countOtherCandidaciesMock.mockResolvedValue(new Map());
  findBlockedEmailsMock.mockResolvedValue(new Set());
  receivedEmailMock.mockResolvedValue(undefined);
  confirmationEmailMock.mockResolvedValue(undefined);
  withdrawnNoticeMock.mockResolvedValue(undefined);
  recordEventMock.mockResolvedValue(undefined);
  txFake.organizationApplicationOwner.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Row }) => ({
      ...(where.id === "c-binh" ? binh() : candidate({ id: where.id })),
      ...data,
      sentCount: 1,
    }),
  );
  txFake.organizationApplicationOwner.count.mockResolvedValue(1);
  txFake.organizationApplication.update.mockResolvedValue(undefined);
  txFake.organizationApplicationOwner.updateMany.mockResolvedValue(undefined);
});

describe("validateOwnerList", () => {
  const owner = (email: string, isLegalRep = false) => ({ email, isLegalRep });

  it("hợp lệ khi có người nộp và đúng một người đại diện pháp lý", () => {
    expect(() =>
      validateOwnerList([owner(SUBMITTER, true), owner("b@x.vn")], SUBMITTER),
    ).not.toThrow();
  });

  it.each([
    ["danh sách rỗng", [], "AT_LEAST_ONE_OWNER"],
    [
      "quá 5 owner",
      ["1", "2", "3", "4", "5"].map((n) => owner(`${n}@x.vn`)).concat(owner(SUBMITTER, true)),
      "TOO_MANY_OWNERS",
    ],
    [
      "trùng email (khác hoa thường)",
      [owner(SUBMITTER, true), owner("AN@clb.vn")],
      "DUPLICATE_OWNER_EMAIL",
    ],
    ["người nộp không nằm trong danh sách", [owner("b@x.vn", true)], "SUBMITTER_MUST_BE_OWNER"],
    ["không có người đại diện pháp lý", [owner(SUBMITTER)], "EXACTLY_ONE_LEGAL_REP"],
    [
      "hai người đại diện pháp lý",
      [owner(SUBMITTER, true), owner("b@x.vn", true)],
      "EXACTLY_ONE_LEGAL_REP",
    ],
  ])("%s → %s", (_label, owners, code) => {
    expect(() => validateOwnerList(owners as never, SUBMITTER)).toThrow(
      expect.objectContaining({ statusResponse: expect.objectContaining({ code }) }),
    );
  });
});

describe("OrganizationApplicationService.openDraftForEmail", () => {
  it("đã có hồ sơ mở thì trả lại hồ sơ đó, không tạo bản mới", async () => {
    findOpenBySubmitterEmailMock.mockResolvedValue({ id: "app-old", code: "ORG-OLD" });

    const result = await organizationApplicationService.openDraftForEmail(" AN@clb.vn ");

    expect(result).toEqual({
      applicationId: "app-old",
      trackingToken: "track-new",
      resumed: true,
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("chưa có thì tạo DRAFT, người nộp nằm sẵn trong danh sách owner", async () => {
    findOpenBySubmitterEmailMock.mockResolvedValue(null);
    createMock.mockResolvedValue({ id: "app-new", code: "ORG-NEW" });

    const result = await organizationApplicationService.openDraftForEmail("AN@clb.vn");

    const data = createMock.mock.calls[0][0];
    expect(data).toMatchObject({
      status: "DRAFT",
      submitterEmail: SUBMITTER,
      owners: { create: [expect.objectContaining({ email: SUBMITTER })] },
    });
    expect(data.emailVerifiedAt).toBeInstanceOf(Date);
    expect(issueTrackingTokenMock).toHaveBeenCalledWith(SUBMITTER);
    expect(result.resumed).toBe(false);
  });

  it("bản nháp mới thì gửi một email kèm link vào trình soạn nháp, hạn 180 ngày", async () => {
    findOpenBySubmitterEmailMock.mockResolvedValue(null);
    createMock.mockResolvedValue({ id: "app-new", code: "ORG-NEW" });

    await organizationApplicationService.openDraftForEmail("AN@clb.vn");

    expect(draftStartedEmailMock).toHaveBeenCalledTimes(1);
    const payload = draftStartedEmailMock.mock.calls[0][0];
    expect(payload).toMatchObject({
      toEmail: SUBMITTER,
      applicationCode: "ORG-NEW",
      expiresInDays: 180,
    });
    expect(payload.editUrl).toContain("/organizations/apply/edit/app-new?token=track-new");
  });

  it("mở lại hồ sơ cũ thì không gửi email, tránh dội hộp thư", async () => {
    findOpenBySubmitterEmailMock.mockResolvedValue({ id: "app-old", code: "ORG-OLD" });

    await organizationApplicationService.openDraftForEmail("AN@clb.vn");

    expect(draftStartedEmailMock).not.toHaveBeenCalled();
  });

  it("gửi mail hỏng thì vẫn trả bản nháp bình thường", async () => {
    findOpenBySubmitterEmailMock.mockResolvedValue(null);
    createMock.mockResolvedValue({ id: "app-new", code: "ORG-NEW" });
    draftStartedEmailMock.mockRejectedValue(new Error("smtp down"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await organizationApplicationService.openDraftForEmail("AN@clb.vn");
    await new Promise((resolve) => setImmediate(resolve));

    expect(result).toEqual({
      applicationId: "app-new",
      trackingToken: "track-new",
      resumed: false,
    });
    warn.mockRestore();
  });
});

describe("OrganizationApplicationService.submitApplication — kiểm tra chặn sớm", () => {
  beforeEach(() => useApplication(application()));

  const submit = () =>
    organizationApplicationService.submitApplication("app-1", "track", {}, META);

  it("owner có tài khoản bị đình chỉ → OWNER_SUSPENDED, không gửi email nào", async () => {
    lookupUsersMock.mockResolvedValue(
      new Map([["binh@gmail.com", { id: "u-binh", status: 2 }]]),
    );

    await expect(submit()).rejects.toMatchObject({
      statusResponse: { code: "OWNER_SUSPENDED" },
    });
    expect(transactionMock).not.toHaveBeenCalled();
    expect(confirmationEmailMock).not.toHaveBeenCalled();
  });

  it("owner đã làm owner 3 tổ chức → OWNER_QUOTA_EXCEEDED", async () => {
    lookupUsersMock.mockResolvedValue(
      new Map([["binh@gmail.com", { id: "u-binh", status: 1 }]]),
    );
    countOwnerOrgsMock.mockResolvedValue(new Map([["u-binh", 3]]));

    await expect(submit()).rejects.toMatchObject({
      statusResponse: { code: "OWNER_QUOTA_EXCEEDED" },
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("email đang là candidate ở 2 hồ sơ khác → TOO_MANY_PENDING_INVITES (chống spam)", async () => {
    countOtherCandidaciesMock.mockResolvedValue(new Map([["binh@gmail.com", 2]]));

    await expect(submit()).rejects.toMatchObject({
      statusResponse: { code: "TOO_MANY_PENDING_INVITES" },
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("email đã chọn chặn mọi lời mời → OWNER_INVITE_BLOCKED", async () => {
    findBlockedEmailsMock.mockResolvedValue(new Set(["binh@gmail.com"]));

    await expect(submit()).rejects.toMatchObject({
      statusResponse: { code: "OWNER_INVITE_BLOCKED" },
    });
    // Người nộp đã qua OTP nên không bị đem đi so với danh sách chặn.
    expect(findBlockedEmailsMock).toHaveBeenCalledWith(["binh@gmail.com"]);
  });

  it("còn owner đã từ chối trong danh sách → OWNER_DECLINED_MUST_BE_REPLACED", async () => {
    useApplication(
      application({
        status: "NEEDS_REVISION",
        owners: [candidate({ status: "CONFIRMED" }), binh({ status: "DECLINED" })],
      }),
    );

    await expect(submit()).rejects.toMatchObject({
      statusResponse: { code: "OWNER_DECLINED_MUST_BE_REPLACED" },
    });
    expect(lookupUsersMock).not.toHaveBeenCalled();
  });

  it("identity không trả lời được thì 503, không nộp bừa", async () => {
    lookupUsersMock.mockRejectedValue(new Error("identity down"));

    await expect(submit()).rejects.toMatchObject({
      statusResponse: { status: 503 },
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("hồ sơ đang chờ xác nhận thì không nộp lại được", async () => {
    useApplication(application({ status: "AWAITING_OWNER_CONFIRMATION" }));

    await expect(submit()).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_APPLICATION_NOT_EDITABLE" },
    });
  });
});

describe("OrganizationApplicationService.submitApplication — xác nhận", () => {
  const submit = () =>
    organizationApplicationService.submitApplication("app-1", "track", {}, META);

  const updatesFor = (id: string) =>
    txFake.organizationApplicationOwner.update.mock.calls
      .map((c) => c[0])
      .filter((arg: { where: { id: string } }) => arg.where.id === id);

  it("người nộp tự được xác nhận (kèm IP, UA); owner khác nhận link 14 ngày, chỉ lưu hash", async () => {
    useApplication(application());

    await submit();

    const [submitterUpdate] = updatesFor("c-an");
    expect(submitterUpdate.data).toMatchObject({
      status: "CONFIRMED",
      confirmIp: META.ip,
      confirmUa: META.userAgent,
      confirmTokenHash: null,
    });

    const [binhUpdate] = updatesFor("c-binh");
    const expiresIn = binhUpdate.data.expiresAt.getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(13.9 * 24 * 60 * 60 * 1000);
    expect(expiresIn).toBeLessThanOrEqual(14 * 24 * 60 * 60 * 1000);

    const mail = confirmationEmailMock.mock.calls[0][0];
    expect(mail.toEmail).toBe("binh@gmail.com");
    const rawToken = new URL(mail.confirmUrl).searchParams.get("token")!;
    expect(binhUpdate.data.confirmTokenHash).toBe(hashOpaqueToken(rawToken));
    expect(mail.otherOwners).toContain(SUBMITTER);
    expect(confirmationEmailMock).toHaveBeenCalledTimes(1);

    expect(txFake.organizationApplication.update.mock.calls[0][0].data.status).toBe(
      "AWAITING_OWNER_CONFIRMATION",
    );
    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "SUBMITTED" }),
    );
    expect(receivedEmailMock).toHaveBeenCalled();
  });

  it("chỉ có một owner là người nộp thì vào thẳng hàng chờ thẩm định", async () => {
    useApplication(application({ owners: [candidate()] }));
    txFake.organizationApplicationOwner.count.mockResolvedValue(0);

    await submit();

    expect(txFake.organizationApplication.update.mock.calls[0][0].data.status).toBe(
      "PENDING_REVIEW",
    );
    expect(confirmationEmailMock).not.toHaveBeenCalled();
    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "READY_FOR_REVIEW" }),
    );
  });

  const confirmedApp = (overrides: Row = {}, owners?: Row[]) => {
    const base = application({ status: "NEEDS_REVISION", ...overrides });
    const list = owners ?? [
      candidate({ status: "CONFIRMED", respondedAt: new Date() }),
      binh({ status: "CONFIRMED", respondedAt: new Date() }),
    ];
    const snapshotOwners = [candidate(), binh()] as {
      email: string;
      isLegalRep: boolean;
    }[];
    return {
      ...base,
      owners: list,
      // What the owners agreed to at the previous submission (original name, both owners).
      confirmationSnapshot: {
        snapshot: buildConfirmationSnapshot({
          name: "CLB Tình nguyện UIT",
          orgType: "CLUB",
          owners: snapshotOwners,
        }),
      },
    };
  };

  it("đổi tên tổ chức sau khi đã có xác nhận → reset toàn bộ về PENDING và gửi lại link", async () => {
    useApplication(
      confirmedApp({
        profile: {
          name: "CLB Khác Hẳn",
          logoUrl: "https://res.cloudinary.com/demo/logo.png",
        },
      }),
    );

    await submit();

    expect(updatesFor("c-binh")[0].data.status).toBe("PENDING");
    expect(confirmationEmailMock).toHaveBeenCalledTimes(1);
    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "OWNER_CONFIRMATIONS_RESET" }),
    );
    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "RESUBMITTED" }),
    );
  });

  it("thêm owner mới cũng là đổi danh sách → reset", async () => {
    useApplication(
      confirmedApp({}, [
        candidate({ status: "CONFIRMED" }),
        binh({ status: "CONFIRMED" }),
        candidate({ id: "c-chi", email: "chi@gmail.com", fullName: "Chi", isLegalRep: false }),
      ]),
    );

    await submit();

    expect(updatesFor("c-binh")[0].data.status).toBe("PENDING");
    expect(confirmationEmailMock).toHaveBeenCalledTimes(2);
  });

  it("chỉ sửa mô tả thì giữ nguyên xác nhận, không làm phiền ai", async () => {
    useApplication(
      confirmedApp({
        profile: {
          name: "CLB Tình nguyện UIT",
          logoUrl: "https://res.cloudinary.com/demo/logo.png",
          description: "Mô tả mới hoàn toàn",
        },
      }),
    );
    txFake.organizationApplicationOwner.count.mockResolvedValue(0);

    await submit();

    expect(updatesFor("c-binh")).toHaveLength(0);
    expect(confirmationEmailMock).not.toHaveBeenCalled();
    expect(recordEventMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "OWNER_CONFIRMATIONS_RESET" }),
    );
    expect(txFake.organizationApplication.update.mock.calls[0][0].data.status).toBe(
      "PENDING_REVIEW",
    );
    // Nộp lại thì không gửi lại mail "đã nhận hồ sơ".
    expect(receivedEmailMock).not.toHaveBeenCalled();
  });

  it("owner hết hạn nhưng vẫn giữ trong danh sách thì được gửi link mới", async () => {
    useApplication(
      confirmedApp({}, [
        candidate({ status: "CONFIRMED" }),
        binh({ status: "EXPIRED", confirmTokenHash: "old" }),
      ]),
    );

    await submit();

    expect(updatesFor("c-binh")[0].data).toMatchObject({ status: "PENDING" });
    expect(confirmationEmailMock).toHaveBeenCalledTimes(1);
  });
});

describe("OrganizationApplicationService.resendOwnerInvite", () => {
  const awaiting = (b: Row) =>
    application({
      status: "AWAITING_OWNER_CONFIRMATION",
      owners: [candidate({ status: "CONFIRMED" }), binh(b)],
    });

  it("gửi lại: sinh token mới (token cũ mất hiệu lực) và ghi audit", async () => {
    useApplication(
      awaiting({ sentCount: 1, sentAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }),
    );

    await organizationApplicationService.resendOwnerInvite("app-1", "track", "c-binh");

    const update = txFake.organizationApplicationOwner.update.mock.calls[0][0];
    expect(update.where.id).toBe("c-binh");
    expect(update.data.confirmTokenHash).toEqual(expect.any(String));
    expect(update.data.sentCount).toEqual({ increment: 1 });
    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "OWNER_INVITE_RESENT" }),
    );
    expect(confirmationEmailMock).toHaveBeenCalledTimes(1);
  });

  it("không giới hạn số lần gửi lại: đã gửi 10 lần, quá 1 giờ thì vẫn gửi được", async () => {
    useApplication(awaiting({ sentCount: 10, sentAt: new Date(0) }));

    await organizationApplicationService.resendOwnerInvite("app-1", "track", "c-binh");

    expect(confirmationEmailMock).toHaveBeenCalledTimes(1);
  });

  it("chưa đủ 1 giờ kể từ lần gửi trước thì RESEND_TOO_SOON", async () => {
    useApplication(awaiting({ sentCount: 1, sentAt: new Date() }));

    await expect(
      organizationApplicationService.resendOwnerInvite("app-1", "track", "c-binh"),
    ).rejects.toMatchObject({ statusResponse: { code: "RESEND_TOO_SOON" } });
  });

  it("owner đã trả lời thì không gửi lại được", async () => {
    useApplication(awaiting({ status: "CONFIRMED", sentCount: 1, sentAt: new Date(0) }));

    await expect(
      organizationApplicationService.resendOwnerInvite("app-1", "track", "c-binh"),
    ).rejects.toMatchObject({ statusResponse: { status: 404 } });
  });
});

describe("OrganizationApplicationService.withdrawApplication", () => {
  it("rút khi đang chờ xác nhận: vô hiệu link chưa dùng, báo owner đã xác nhận (trừ người nộp)", async () => {
    useApplication(
      application({
        status: "AWAITING_OWNER_CONFIRMATION",
        owners: [
          candidate({ status: "CONFIRMED" }),
          binh({ status: "CONFIRMED" }),
          candidate({ id: "c-chi", email: "chi@gmail.com", isLegalRep: false }),
        ],
      }),
    );

    await organizationApplicationService.withdrawApplication("app-1", "track");

    expect(txFake.organizationApplication.update.mock.calls[0][0].data.status).toBe(
      "WITHDRAWN",
    );
    const voided = txFake.organizationApplicationOwner.updateMany.mock.calls[0][0];
    expect(voided.where).toMatchObject({ applicationId: "app-1", status: "PENDING" });
    expect(voided.data.expiresAt).toBeInstanceOf(Date);
    expect(withdrawnNoticeMock).toHaveBeenCalledTimes(1);
    expect(withdrawnNoticeMock.mock.calls[0][0].toEmail).toBe("binh@gmail.com");
  });

  it("rút được cả bản nháp", async () => {
    useApplication(application({ status: "DRAFT" }));

    await organizationApplicationService.withdrawApplication("app-1", "track");

    expect(txFake.organizationApplication.update).toHaveBeenCalled();
  });

  it("hồ sơ đã có quyết định thì không rút được", async () => {
    useApplication(application({ status: "APPROVED" }));

    await expect(
      organizationApplicationService.withdrawApplication("app-1", "track"),
    ).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_APPLICATION_ALREADY_DECIDED" },
    });
  });
});

describe("OrganizationApplicationService.saveDraft", () => {
  beforeEach(() => {
    useApplication(application());
    txFake.organizationApplication.findUniqueOrThrow.mockResolvedValue({
      status: "DRAFT",
    });
  });

  it("đồng bộ danh sách owner theo email: thêm mới, gỡ thì đánh dấu removed chứ không xoá", async () => {
    txFake.organizationApplicationOwner.findMany.mockResolvedValue([
      candidate(),
      binh(),
    ]);

    await organizationApplicationService.saveDraft("app-1", "track", {
      owners: [
        { email: "AN@clb.vn", fullName: "Nguyen An", isLegalRep: true },
        { email: "chi@gmail.com", fullName: "Le Chi" },
      ],
    });

    expect(txFake.organizationApplicationOwner.create.mock.calls[0][0].data).toMatchObject({
      email: "chi@gmail.com",
    });
    const removal = txFake.organizationApplicationOwner.update.mock.calls.find(
      (c) => c[0].where.id === "c-binh",
    )?.[0];
    expect(removal.data.removedAt).toBeInstanceOf(Date);
    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "OWNER_CANDIDATE_REMOVED" }),
    );
  });

  it("chặn danh sách trùng email ngay lúc lưu", async () => {
    await expect(
      organizationApplicationService.saveDraft("app-1", "track", {
        owners: [
          { email: SUBMITTER, fullName: "An" },
          { email: "An@Clb.vn", fullName: "An 2" },
        ],
      }),
    ).rejects.toMatchObject({ statusResponse: { code: "DUPLICATE_OWNER_EMAIL" } });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("chỉ lưu hash + 4 số cuối của giấy tờ người đại diện", async () => {
    await organizationApplicationService.saveDraft("app-1", "track", {
      legalRepresentative: { idType: "CCCD", idNumber: "079123456789" },
    });

    const data = txFake.organizationApplication.update.mock.calls[0][0].data;
    expect(data.legalRepIdHash).toBe(hashOpaqueToken("079123456789"));
    expect(data.legalRepIdLast4).toBe("6789");
    expect(JSON.stringify(data)).not.toContain("079123456789");
  });

  it("bấm Lưu nháp (notifySubmitter) thì gửi email 'đã cập nhật' kèm link và ghi event", async () => {
    const result = await organizationApplicationService.saveDraft("app-1", "track", {
      orgType: "NGO",
      notifySubmitter: true,
    });

    expect(result.notified).toBe(true);
    expect(draftUpdatedEmailMock).toHaveBeenCalledTimes(1);
    const payload = draftUpdatedEmailMock.mock.calls[0][0];
    expect(payload.toEmail).toBe(SUBMITTER);
    expect(payload.editUrl).toContain("/organizations/apply/edit/app-1?token=track");
    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "DRAFT_UPDATE_NOTIFIED" }),
    );
  });

  it("lưu qua Continue (không có notifySubmitter) thì không gửi email", async () => {
    const result = await organizationApplicationService.saveDraft("app-1", "track", {
      orgType: "NGO",
    });

    expect(result.notified).toBe(false);
    expect(draftUpdatedEmailMock).not.toHaveBeenCalled();
    expect(findLatestEventMock).not.toHaveBeenCalled();
  });

  it("đã gửi trong vòng 1 giờ thì lưu vẫn thành công nhưng không gửi thêm", async () => {
    findLatestEventMock.mockResolvedValue({
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    const result = await organizationApplicationService.saveDraft("app-1", "track", {
      orgType: "NGO",
      notifySubmitter: true,
    });

    expect(result.notified).toBe(false);
    expect(draftUpdatedEmailMock).not.toHaveBeenCalled();
    expect(txFake.organizationApplication.update).toHaveBeenCalled();
  });

  it("quá 1 giờ kể từ lần gửi trước thì gửi lại", async () => {
    findLatestEventMock.mockResolvedValue({
      createdAt: new Date(Date.now() - 61 * 60 * 1000),
    });

    const result = await organizationApplicationService.saveDraft("app-1", "track", {
      notifySubmitter: true,
    });

    expect(result.notified).toBe(true);
    expect(draftUpdatedEmailMock).toHaveBeenCalledTimes(1);
  });

  it("gửi mail hỏng thì việc lưu vẫn thành công", async () => {
    draftUpdatedEmailMock.mockRejectedValue(new Error("smtp down"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await organizationApplicationService.saveDraft("app-1", "track", {
      notifySubmitter: true,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.application).toBeDefined();
    warn.mockRestore();
  });

  it("hồ sơ đã nộp thì không sửa được", async () => {
    useApplication(application({ status: "PENDING_REVIEW" }));

    await expect(
      organizationApplicationService.saveDraft("app-1", "track", { orgType: "NGO" }),
    ).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_APPLICATION_NOT_EDITABLE" },
    });
  });
});

describe("OrganizationApplicationService.presignDocumentForApplication", () => {
  beforeEach(() => {
    useApplication(application());
    countUnattachedDocumentsMock.mockResolvedValue(0);
    createSignedUploadMock.mockReturnValue({
      uploadUrl: "https://api.cloudinary.com/v1_1/demo/image/upload",
      fields: { signature: "sig" },
      storageKey: "folder/public-id",
      expiresAt: new Date().toISOString(),
    });
    createDocumentMock.mockResolvedValue({ id: "doc-1" });
  });

  const presign = (input: Partial<Record<string, unknown>> = {}) =>
    organizationApplicationService.presignDocumentForApplication("app-1", "track", {
      docType: "BUSINESS_LICENSE",
      fileName: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1000,
      ...input,
    } as never);

  it("chỉ nhận pdf / jpg / png", async () => {
    await expect(presign({ mimeType: "application/msword" })).rejects.toMatchObject({
      statusResponse: { status: 400 },
    });
  });

  it("chặn file quá 10 MB", async () => {
    await expect(presign({ sizeBytes: 11 * 1024 * 1024 })).rejects.toMatchObject({
      statusResponse: { status: 400 },
    });
  });

  it("gắn file với hòm mail người nộp và format suy ra từ mime type", async () => {
    const result = await presign();

    expect(createDocumentMock.mock.calls[0][0]).toMatchObject({
      submissionEmail: SUBMITTER,
      format: "pdf",
      storageKey: "folder/public-id",
    });
    expect(result.documentId).toBe("doc-1");
  });

  it("hồ sơ đã nộp thì không upload thêm được", async () => {
    useApplication(application({ status: "AWAITING_OWNER_CONFIRMATION" }));

    await expect(presign()).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_APPLICATION_NOT_EDITABLE" },
    });
  });
});

describe("OrganizationApplicationService.openDocumentForApplicant", () => {
  const doc = (overrides: Row = {}) => ({
    id: "doc-1",
    applicationId: "app-1",
    docType: "BUSINESS_LICENSE",
    storageKey: "key",
    format: "pdf",
    fileName: "giay-phep.pdf",
    purgedAt: null,
    ...overrides,
  });

  beforeEach(() => {
    useApplication(application());
    findDocumentByIdMock.mockResolvedValue(doc());
    downloadMock.mockResolvedValue({ stream: {}, contentType: "application/pdf" });
  });

  it("mở được giấy tờ của chính hồ sơ và ghi lại lượt xem không có actor", async () => {
    const file = await organizationApplicationService.openDocumentForApplicant(
      "app-1",
      "track",
      "doc-1",
    );

    expect(file.fileName).toBe("giay-phep.pdf");
    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "DOCUMENT_VIEWED",
        actorId: null,
        payload: expect.objectContaining({ viewer: "applicant" }),
      }),
    );
  });

  it("không mở được giấy tờ thuộc hồ sơ khác", async () => {
    findDocumentByIdMock.mockResolvedValue(doc({ applicationId: "app-2" }));

    await expect(
      organizationApplicationService.openDocumentForApplicant("app-1", "track", "doc-1"),
    ).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_DOCUMENT_NOT_FOUND" },
    });
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it("tracking token của hòm mail khác thì không thấy hồ sơ", async () => {
    resolveTrackingTokenMock.mockResolvedValue("stranger@x.vn");

    await expect(
      organizationApplicationService.openDocumentForApplicant("app-1", "track", "doc-1"),
    ).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_APPLICATION_NOT_FOUND" },
    });
  });
});
