/**
 * Lời mời thành viên: ai trong tổ chức cũng mời được, nhưng người không có quyền duyệt thì
 * lời mời phải chờ owner/admin; chỉ khi được duyệt mới có link, và người được mời vẫn phải
 * tự bấm chấp nhận. Vai lấy từ `findActiveRole` (mock); ma trận quyền là thật.
 */
import { Prisma } from "@prisma/client";

const findActiveRoleMock = jest.fn();
const findAllActiveByOrganizationMock = jest.fn();
const orgFindByIdMock = jest.fn();
const lookupUsersByIdsMock = jest.fn();
const searchUsersMock = jest.fn();
const invitationEmailMock = jest.fn();
const pendingNotifyMock = jest.fn();
const rejectedNotifyMock = jest.fn();
const fetchProfilesMock = jest.fn();
const grantMembershipMock = jest.fn();

const invitationModel = {
  create: jest.fn(),
  findMany: jest.fn(),
  findUnique: jest.fn(),
  updateMany: jest.fn(),
};
const txFake = {
  $queryRaw: jest.fn(),
  organizationInvitation: { findUnique: jest.fn(), update: jest.fn() },
  organizationMember: { findFirst: jest.fn() },
};
const transactionMock = jest.fn(async (cb: (tx: unknown) => unknown) => cb(txFake));

jest.mock("../../../config/prisma.client", () => ({
  __esModule: true,
  default: {
    $transaction: (cb: never) => transactionMock(cb),
    organizationInvitation: invitationModel,
  },
}));

jest.mock("../organization_member.repository", () => ({
  organizationMemberRepository: {
    findActiveRole: (...a: unknown[]) => findActiveRoleMock(...a),
    findAllActiveByOrganization: (...a: unknown[]) =>
      findAllActiveByOrganizationMock(...a),
  },
}));

jest.mock("../organization.repository", () => ({
  organizationRepository: { findById: (...a: unknown[]) => orgFindByIdMock(...a) },
}));

jest.mock("../../organization_application/identity-owner.client", () => ({
  IdentityUserStatus: { ACTIVE: 1, INACTIVE: 2, PENDING_ACTIVATION: 3 },
  lookupUsersByIds: (...a: unknown[]) => lookupUsersByIdsMock(...a),
  searchUsers: (...a: unknown[]) => searchUsersMock(...a),
}));

jest.mock("../../organization_application/organization-application-notify.client", () => ({
  enqueueOrgInvitationEmail: (...a: unknown[]) => invitationEmailMock(...a),
}));

jest.mock("../organization-member-notify.client", () => ({
  enqueueOrgInvitationPendingWebsiteNotification: (...a: unknown[]) =>
    pendingNotifyMock(...a),
  enqueueOrgInvitationRejectedWebsiteNotification: (...a: unknown[]) =>
    rejectedNotifyMock(...a),
}));

jest.mock("../identity-user.client", () => ({
  fetchOrganizationOwnersByUserIds: (...a: unknown[]) => fetchProfilesMock(...a),
  getUserProfile: (map: Map<string, unknown>, id: string) => map.get(id),
}));

jest.mock("../organization-membership.service", () => ({
  organizationMembershipService: {
    grantMembership: (...a: unknown[]) => grantMembershipMock(...a),
  },
}));

import {
  maskEmail,
  organizationInvitationService,
} from "../organization-invitation.service";
import { hashOpaqueToken } from "../../../utils/token-hash";

const ORG = "org-1";
const OWNER = "u-owner";
const ADMIN = "u-admin";
const MEMBER = "u-member";
const INVITEE = "u-invitee";

function roles(map: Record<string, string | null>) {
  findActiveRoleMock.mockImplementation(async (_org: string, userId: string) =>
    userId in map ? map[userId] : null,
  );
  findAllActiveByOrganizationMock.mockResolvedValue(
    Object.entries(map)
      .filter(([, role]) => role)
      .map(([userId, role]) => ({ userId, role })),
  );
}

type Row = Record<string, unknown>;
const invitation = (overrides: Row = {}): Row => ({
  id: "inv-1",
  organizationId: ORG,
  inviterId: MEMBER,
  inviteeUserId: INVITEE,
  inviteeEmail: "binh@gmail.com",
  role: "MEMBER",
  status: "PENDING_APPROVAL",
  approvedBy: null,
  approvedAt: null,
  tokenHash: null,
  expiresAt: null,
  respondedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

/** Same row for the token lookup and the locked re-read inside the transaction. */
function useInvitation(row: Row) {
  invitationModel.findUnique.mockResolvedValue(row);
  txFake.organizationInvitation.findUnique.mockResolvedValue(row);
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  orgFindByIdMock.mockResolvedValue({
    id: ORG,
    name: "CLB Xanh",
    slug: "clb-xanh",
    logoUrl: "https://x/logo.png",
    description: null,
    descriptionVi: "Mô tả",
  });
  lookupUsersByIdsMock.mockResolvedValue(
    new Map([[INVITEE, { id: INVITEE, email: "binh@gmail.com", name: "Binh", status: 1 }]]),
  );
  fetchProfilesMock.mockResolvedValue(
    new Map([
      [OWNER, { name: "An", avatar: null }],
      [MEMBER, { name: "Chi", avatar: null }],
      [INVITEE, { name: "Binh", avatar: null }],
    ]),
  );
  invitationModel.create.mockImplementation(async ({ data }: { data: Row }) =>
    invitation(data),
  );
  txFake.organizationInvitation.update.mockImplementation(
    async ({ data }: { data: Row }) => invitation(data),
  );
  txFake.organizationMember.findFirst.mockResolvedValue(null);
  invitationEmailMock.mockResolvedValue(undefined);
  pendingNotifyMock.mockResolvedValue(undefined);
  rejectedNotifyMock.mockResolvedValue(undefined);
});

describe("maskEmail", () => {
  it("chỉ giữ 2 ký tự đầu và tên miền", () => {
    expect(maskEmail("nngtkhngoc05@gmail.com")).toBe("nn***@gmail.com");
    expect(maskEmail("ab@x.vn")).toBe("a***@x.vn");
    expect(maskEmail("khong-hop-le")).toBe("***");
  });
});

describe("OrganizationInvitationService.create", () => {
  it("member mời: lời mời chờ duyệt, báo owner/admin, CHƯA gửi email", async () => {
    roles({ [MEMBER]: "MEMBER", [OWNER]: "OWNER", [ADMIN]: "ADMIN" });

    const result = await organizationInvitationService.create(ORG, MEMBER, INVITEE);
    await flush();

    const data = invitationModel.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: "PENDING_APPROVAL", role: "MEMBER" });
    expect(data.tokenHash).toBeUndefined();
    expect(invitationEmailMock).not.toHaveBeenCalled();
    expect(pendingNotifyMock.mock.calls[0][0].userIds.sort()).toEqual([ADMIN, OWNER].sort());
    // Người mời không có quyền duyệt chỉ thấy email đã ẩn bớt, kể cả trong response.
    expect(result.invitee.email).toBe("bi***@gmail.com");
  });

  it("owner mời: gửi ngay (SENT), lưu hash của token, email có link", async () => {
    roles({ [OWNER]: "OWNER" });

    await organizationInvitationService.create(ORG, OWNER, INVITEE);

    const data = invitationModel.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: "SENT", approvedBy: OWNER });
    expect(data.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(data.expiresAt).toBeInstanceOf(Date);
    const mail = invitationEmailMock.mock.calls[0][0];
    expect(mail.toEmail).toBe("binh@gmail.com");
    expect(mail.invitationUrl).toContain("/organizations/invitations?token=");
    const raw = decodeURIComponent(mail.invitationUrl.split("token=")[1]);
    expect(hashOpaqueToken(raw)).toBe(data.tokenHash);
    expect(pendingNotifyMock).not.toHaveBeenCalled();
  });

  it("owner (có quyền duyệt) thấy email đầy đủ trong response", async () => {
    roles({ [OWNER]: "OWNER" });

    const result = await organizationInvitationService.create(ORG, OWNER, INVITEE);

    expect(result.invitee.email).toBe("binh@gmail.com");
  });

  it("người được mời đã là thành viên → ALREADY_MEMBER", async () => {
    roles({ [OWNER]: "OWNER", [INVITEE]: "MEMBER" });

    await expect(
      organizationInvitationService.create(ORG, OWNER, INVITEE),
    ).rejects.toMatchObject({ statusResponse: { code: "ALREADY_MEMBER" } });
  });

  it("tài khoản bị khoá → INVITEE_NOT_AVAILABLE", async () => {
    roles({ [OWNER]: "OWNER" });
    lookupUsersByIdsMock.mockResolvedValue(
      new Map([[INVITEE, { id: INVITEE, email: "b@x.vn", name: "B", status: 2 }]]),
    );

    await expect(
      organizationInvitationService.create(ORG, OWNER, INVITEE),
    ).rejects.toMatchObject({ statusResponse: { code: "INVITEE_NOT_AVAILABLE" } });
  });

  it("đã có lời mời đang mở (unique partial index) → INVITATION_ALREADY_PENDING", async () => {
    roles({ [OWNER]: "OWNER" });
    invitationModel.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }),
    );

    await expect(
      organizationInvitationService.create(ORG, OWNER, INVITEE),
    ).rejects.toMatchObject({ statusResponse: { code: "INVITATION_ALREADY_PENDING" } });
  });

  it("người ngoài tổ chức không mời được → ORG_PERMISSION_DENIED", async () => {
    roles({});

    await expect(
      organizationInvitationService.create(ORG, "u-stranger", INVITEE),
    ).rejects.toMatchObject({ statusResponse: { code: "ORG_PERMISSION_DENIED" } });
  });
});

describe("OrganizationInvitationService.approve / reject / cancel", () => {
  it("admin duyệt lời mời chờ duyệt → SENT kèm token, gửi email", async () => {
    roles({ [ADMIN]: "ADMIN" });
    txFake.organizationInvitation.findUnique.mockResolvedValue(invitation());

    await organizationInvitationService.approve(ORG, "inv-1", ADMIN);

    const data = txFake.organizationInvitation.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: "SENT", approvedBy: ADMIN });
    expect(data.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(invitationEmailMock).toHaveBeenCalledTimes(1);
  });

  it("chỉ duyệt được lời mời đang chờ duyệt → INVITATION_NOT_ACTIVE", async () => {
    roles({ [ADMIN]: "ADMIN" });
    txFake.organizationInvitation.findUnique.mockResolvedValue(
      invitation({ status: "SENT" }),
    );

    await expect(
      organizationInvitationService.approve(ORG, "inv-1", ADMIN),
    ).rejects.toMatchObject({ statusResponse: { code: "INVITATION_NOT_ACTIVE" } });
  });

  it("người được mời đã vào bằng đường khác trong lúc chờ → huỷ lời mời, ALREADY_MEMBER", async () => {
    roles({ [ADMIN]: "ADMIN" });
    txFake.organizationInvitation.findUnique.mockResolvedValue(invitation());
    txFake.organizationMember.findFirst.mockResolvedValue({ role: "MEMBER" });

    await expect(
      organizationInvitationService.approve(ORG, "inv-1", ADMIN),
    ).rejects.toMatchObject({ statusResponse: { code: "ALREADY_MEMBER" } });
    expect(txFake.organizationInvitation.update.mock.calls[0][0].data.status).toBe(
      "CANCELLED",
    );
    expect(invitationEmailMock).not.toHaveBeenCalled();
  });

  it("member không duyệt được → ORG_PERMISSION_DENIED", async () => {
    roles({ [MEMBER]: "MEMBER" });

    await expect(
      organizationInvitationService.approve(ORG, "inv-1", MEMBER),
    ).rejects.toMatchObject({ statusResponse: { code: "ORG_PERMISSION_DENIED" } });
  });

  it("từ chối → REJECTED và báo người mời", async () => {
    roles({ [OWNER]: "OWNER" });
    txFake.organizationInvitation.findUnique.mockResolvedValue(invitation());

    await organizationInvitationService.reject(ORG, "inv-1", OWNER);
    await flush();

    expect(txFake.organizationInvitation.update.mock.calls[0][0].data.status).toBe(
      "REJECTED",
    );
    expect(rejectedNotifyMock.mock.calls[0][0]).toMatchObject({
      userId: MEMBER,
      inviteeName: "Binh",
    });
  });

  it("người mời tự huỷ được lời mời của mình", async () => {
    roles({ [MEMBER]: "MEMBER" });
    txFake.organizationInvitation.findUnique.mockResolvedValue(invitation());

    await organizationInvitationService.cancel(ORG, "inv-1", MEMBER);

    expect(txFake.organizationInvitation.update.mock.calls[0][0].data.status).toBe(
      "CANCELLED",
    );
  });

  it("member khác không huỷ được lời mời của người khác", async () => {
    roles({ "u-other": "MEMBER" });
    txFake.organizationInvitation.findUnique.mockResolvedValue(invitation());

    await expect(
      organizationInvitationService.cancel(ORG, "inv-1", "u-other"),
    ).rejects.toMatchObject({ statusResponse: { code: "ORG_PERMISSION_DENIED" } });
  });

  it("lời mời của tổ chức khác → INVITATION_NOT_FOUND", async () => {
    roles({ [OWNER]: "OWNER" });
    txFake.organizationInvitation.findUnique.mockResolvedValue(
      invitation({ organizationId: "org-2" }),
    );

    await expect(
      organizationInvitationService.cancel(ORG, "inv-1", OWNER),
    ).rejects.toMatchObject({ statusResponse: { code: "INVITATION_NOT_FOUND" } });
  });
});

describe("OrganizationInvitationService.list", () => {
  beforeEach(() => invitationModel.findMany.mockResolvedValue([invitation()]));

  it("người có quyền duyệt thấy mọi lời mời, email đầy đủ", async () => {
    roles({ [ADMIN]: "ADMIN" });

    const list = await organizationInvitationService.list(ORG, ADMIN);

    expect(invitationModel.findMany.mock.calls[0][0].where).toEqual({ organizationId: ORG });
    expect(list[0].invitee.email).toBe("binh@gmail.com");
  });

  it("member chỉ thấy lời mời của chính mình, email bị ẩn bớt", async () => {
    roles({ [MEMBER]: "MEMBER" });

    const list = await organizationInvitationService.list(ORG, MEMBER, "SENT");

    expect(invitationModel.findMany.mock.calls[0][0].where).toEqual({
      organizationId: ORG,
      status: "SENT",
      inviterId: MEMBER,
    });
    expect(list[0].invitee.email).toBe("bi***@gmail.com");
  });

  it("lời mời SENT đã quá hạn hiển thị là EXPIRED", async () => {
    roles({ [ADMIN]: "ADMIN" });
    invitationModel.findMany.mockResolvedValue([
      invitation({ status: "SENT", expiresAt: new Date(Date.now() - 1000) }),
    ]);

    const list = await organizationInvitationService.list(ORG, ADMIN);

    expect(list[0].status).toBe("EXPIRED");
  });
});

describe("OrganizationInvitationService.searchUsers", () => {
  beforeEach(() =>
    searchUsersMock.mockResolvedValue([
      { id: INVITEE, email: "binh@gmail.com", name: "Binh", status: 1 },
      { id: MEMBER, email: "chi@gmail.com", name: "Chi", status: 1 },
    ]),
  );

  it("member tìm: email bị ẩn bớt, đánh dấu người đã là thành viên", async () => {
    roles({ [MEMBER]: "MEMBER" });

    const users = await organizationInvitationService.searchUsers(ORG, MEMBER, " bi ");

    expect(searchUsersMock).toHaveBeenCalledWith("bi", 10);
    expect(users).toEqual([
      expect.objectContaining({ id: INVITEE, email: "bi***@gmail.com", isMember: false }),
      expect.objectContaining({ id: MEMBER, email: "ch***@gmail.com", isMember: true, role: "MEMBER" }),
    ]);
  });

  it("owner tìm (để đề xuất owner): email đầy đủ", async () => {
    roles({ [OWNER]: "OWNER" });

    const users = await organizationInvitationService.searchUsers(ORG, OWNER, "bi");

    expect(users[0].email).toBe("binh@gmail.com");
  });

  it("người ngoài tổ chức → ORG_PERMISSION_DENIED", async () => {
    roles({});

    await expect(
      organizationInvitationService.searchUsers(ORG, "u-stranger", "bi"),
    ).rejects.toMatchObject({ statusResponse: { code: "ORG_PERMISSION_DENIED" } });
    expect(searchUsersMock).not.toHaveBeenCalled();
  });
});

describe("OrganizationInvitationService — trang công khai theo token", () => {
  const sent = () =>
    invitation({
      status: "SENT",
      tokenHash: hashOpaqueToken("raw"),
      expiresAt: new Date(Date.now() + 60_000),
    });

  it("chấp nhận: cấp vai MEMBER (nguồn INVITATION) và đánh dấu ACCEPTED", async () => {
    useInvitation(sent());

    const result = await organizationInvitationService.accept("raw");

    expect(invitationModel.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashOpaqueToken("raw") },
    });
    expect(grantMembershipMock.mock.calls[0][1]).toMatchObject({
      userId: INVITEE,
      organizationId: ORG,
      role: "MEMBER",
      source: "INVITATION",
      sourceRef: "inv-1",
    });
    expect(txFake.organizationInvitation.update.mock.calls[0][0].data.status).toBe(
      "ACCEPTED",
    );
    expect(result).toEqual({ organizationSlug: "clb-xanh" });
  });

  it("bấm chấp nhận lần hai: idempotent, không cấp lại", async () => {
    useInvitation(invitation({ status: "ACCEPTED", tokenHash: hashOpaqueToken("raw") }));

    await organizationInvitationService.accept("raw");

    expect(grantMembershipMock).not.toHaveBeenCalled();
    expect(txFake.organizationInvitation.update).not.toHaveBeenCalled();
  });

  it("link quá hạn → ghi EXPIRED và báo INVITATION_EXPIRED", async () => {
    useInvitation(invitation({ status: "SENT", expiresAt: new Date(Date.now() - 1000) }));

    await expect(organizationInvitationService.accept("raw")).rejects.toMatchObject({
      statusResponse: { code: "INVITATION_EXPIRED" },
    });
    expect(txFake.organizationInvitation.update.mock.calls[0][0].data.status).toBe(
      "EXPIRED",
    );
    expect(grantMembershipMock).not.toHaveBeenCalled();
  });

  it("lời mời đã huỷ / chưa duyệt → INVITATION_NOT_ACTIVE", async () => {
    useInvitation(invitation({ status: "CANCELLED" }));

    await expect(organizationInvitationService.accept("raw")).rejects.toMatchObject({
      statusResponse: { code: "INVITATION_NOT_ACTIVE" },
    });
  });

  it("đã là thành viên (vai cao hơn) thì không hạ vai, vẫn đánh dấu ACCEPTED", async () => {
    useInvitation(sent());
    txFake.organizationMember.findFirst.mockResolvedValue({ role: "ADMIN" });

    await organizationInvitationService.accept("raw");

    expect(grantMembershipMock).not.toHaveBeenCalled();
    expect(txFake.organizationInvitation.update.mock.calls[0][0].data.status).toBe(
      "ACCEPTED",
    );
  });

  it("từ chối → DECLINED; bấm lần hai không đổi gì", async () => {
    useInvitation(sent());
    await organizationInvitationService.decline("raw");
    expect(txFake.organizationInvitation.update.mock.calls[0][0].data.status).toBe(
      "DECLINED",
    );

    jest.clearAllMocks();
    useInvitation(invitation({ status: "DECLINED" }));
    await organizationInvitationService.decline("raw");
    expect(txFake.organizationInvitation.update).not.toHaveBeenCalled();
  });

  it("token không tồn tại → INVITATION_NOT_FOUND", async () => {
    invitationModel.findUnique.mockResolvedValue(null);

    await expect(organizationInvitationService.getByToken("nope")).rejects.toMatchObject({
      statusResponse: { code: "INVITATION_NOT_FOUND" },
    });
  });

  it("tóm tắt: ẩn bớt email; đăng nhập bằng tài khoản khác thì cảnh báo", async () => {
    useInvitation(sent());

    const summary = await organizationInvitationService.getByToken("raw", "u-someone");

    expect(summary).toMatchObject({
      active: true,
      expired: false,
      inviterName: "Chi",
      inviteeName: "Binh",
      inviteeEmail: "bi***@gmail.com",
      sessionMismatch: true,
      organization: { slug: "clb-xanh", description: "Mô tả" },
    });
    const own = await organizationInvitationService.getByToken("raw", INVITEE);
    expect(own.sessionMismatch).toBe(false);
  });

  it("quét hết hạn: SENT quá hạn → EXPIRED", async () => {
    invitationModel.updateMany.mockResolvedValue({ count: 2 });

    const count = await organizationInvitationService.expireOverdue();

    expect(count).toBe(2);
    expect(invitationModel.updateMany.mock.calls[0][0]).toMatchObject({
      where: { status: "SENT" },
      data: { status: "EXPIRED" },
    });
  });
});
