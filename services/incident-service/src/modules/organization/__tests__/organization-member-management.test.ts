/**
 * Quản lý thành viên theo vai (phase 2): đổi vai, gỡ thành viên, duyệt join request, sửa hồ
 * sơ tổ chức. Vai của người gọi lấy từ `findActiveRole` (mock), còn ma trận quyền là thật —
 * test đi qua `org-access` để bắt lỗi ở chỗ nối giữa service và ma trận.
 */

const findActiveRoleMock = jest.fn();
const softDeleteMembershipMock = jest.fn();
const findOwnersByOrganizationIdsMock = jest.fn();
const findAllActiveByOrganizationMock = jest.fn();
const orgFindByIdMock = jest.fn();
const orgUpdateMock = jest.fn();
const findActiveByNameAndContactEmailMock = jest.fn();
const findByIdWithOrganizationMock = jest.fn();
const joinFindByIdMock = jest.fn();
const updateStatusMock = jest.fn();
const grantMembershipMock = jest.fn();
const changeRoleMock = jest.fn();
const membershipChangedMock = jest.fn();
const fetchProfilesMock = jest.fn();

const txFake = { organizationJoiningRequest: { update: jest.fn() } };
const transactionMock = jest.fn(async (cb: (tx: unknown) => unknown) => cb(txFake));

jest.mock("../../../config/prisma.client", () => ({
  __esModule: true,
  default: { $transaction: (cb: never) => transactionMock(cb) },
}));

jest.mock("../organization_member.repository", () => ({
  organizationMemberRepository: {
    findActiveRole: (...a: unknown[]) => findActiveRoleMock(...a),
    softDeleteMembership: (...a: unknown[]) => softDeleteMembershipMock(...a),
    findOwnersByOrganizationIds: (...a: unknown[]) =>
      findOwnersByOrganizationIdsMock(...a),
    findAllActiveByOrganization: (...a: unknown[]) =>
      findAllActiveByOrganizationMock(...a),
    findOwnerUserIds: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock("../organization.repository", () => ({
  organizationRepository: {
    findById: (...a: unknown[]) => orgFindByIdMock(...a),
    update: (...a: unknown[]) => orgUpdateMock(...a),
    findActiveByNameAndContactEmail: (...a: unknown[]) =>
      findActiveByNameAndContactEmailMock(...a),
  },
}));

jest.mock("../organization_joining_request.repository", () => ({
  organizationJoiningRequestRepository: {
    findByIdWithOrganization: (...a: unknown[]) => findByIdWithOrganizationMock(...a),
    findById: (...a: unknown[]) => joinFindByIdMock(...a),
    updateStatus: (...a: unknown[]) => updateStatusMock(...a),
  },
}));

jest.mock("../organization-membership.service", () => ({
  organizationMembershipService: {
    grantMembership: (...a: unknown[]) => grantMembershipMock(...a),
    changeRole: (...a: unknown[]) => changeRoleMock(...a),
  },
}));

jest.mock("../organization-member-notify.client", () => ({
  enqueueOrgMembershipChangedWebsiteNotification: (...a: unknown[]) =>
    membershipChangedMock(...a),
}));

jest.mock("../identity-user.client", () => ({
  fetchOrganizationOwnersByUserIds: (...a: unknown[]) => fetchProfilesMock(...a),
  getUserProfile: (map: Map<string, unknown>, id: string) => map.get(id),
}));

jest.mock("../../campaign/notification-jobs.client", () => ({
  enqueueOrganizationApprovedWebsiteNotification: jest.fn().mockResolvedValue(undefined),
  enqueueOrganizationRejectedWebsiteNotification: jest.fn().mockResolvedValue(undefined),
  enqueueVolunteerApprovedWebsiteNotification: jest.fn().mockResolvedValue(undefined),
  enqueueVolunteerRejectedWebsiteNotification: jest.fn().mockResolvedValue(undefined),
  enqueueVolunteerRequestWebsiteNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../identity-organization-contact-email.client", () => ({
  issueOrganizationContactEmailToken: jest.fn(),
}));
jest.mock("../organization-contact-email-notify.client", () => ({
  enqueueOrganizationContactVerificationEmail: jest.fn(),
}));
jest.mock("../../../queue/register", () => ({
  backgroundJobDispatcher: { enqueue: jest.fn().mockResolvedValue(undefined) },
}));

import { organizationService } from "../organization.service";

const ORG = "org-1";
const ACTOR = "u-actor";
const TARGET = "u-target";

/** Roles by user id for the org under test. */
function roles(map: Record<string, string | null>) {
  findActiveRoleMock.mockImplementation(async (_org: string, userId: string) =>
    userId in map ? map[userId] : null,
  );
}

const organization = {
  id: ORG,
  name: "CLB Xanh",
  slug: "clb-xanh",
  contactEmail: "lienhe@clb.vn",
  status: 1,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  jest.clearAllMocks();
  orgFindByIdMock.mockResolvedValue(organization);
  orgUpdateMock.mockImplementation(async (_id: string, patch: object) => ({
    ...organization,
    ...patch,
  }));
  findActiveByNameAndContactEmailMock.mockResolvedValue(null);
  findOwnersByOrganizationIdsMock.mockResolvedValue(new Map());
  fetchProfilesMock.mockResolvedValue(new Map());
  softDeleteMembershipMock.mockResolvedValue(true);
  membershipChangedMock.mockResolvedValue(undefined);
  changeRoleMock.mockImplementation(async (_tx: unknown, p: Record<string, string>) => ({
    organizationId: p.organizationId,
    userId: p.userId,
    role: p.role,
    createdAt: new Date(),
  }));
});

describe("OrganizationService.changeMemberRole", () => {
  it("owner nâng member lên ADMIN và báo cho người đó", async () => {
    roles({ [ACTOR]: "OWNER", [TARGET]: "MEMBER" });

    const member = await organizationService.changeMemberRole(ORG, ACTOR, TARGET, "ADMIN");

    expect(member.role).toBe("ADMIN");
    expect(changeRoleMock.mock.calls[0][1]).toMatchObject({
      organizationId: ORG,
      userId: TARGET,
      role: "ADMIN",
      actorId: ACTOR,
    });
    expect(membershipChangedMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TARGET, role: "ADMIN" }),
    );
  });

  it("admin gán vai ADMIN → ROLE_NOT_ASSIGNABLE", async () => {
    roles({ [ACTOR]: "ADMIN", [TARGET]: "MEMBER" });

    await expect(
      organizationService.changeMemberRole(ORG, ACTOR, TARGET, "ADMIN"),
    ).rejects.toMatchObject({ statusResponse: { code: "ROLE_NOT_ASSIGNABLE" } });
    expect(changeRoleMock).not.toHaveBeenCalled();
  });

  it("admin đổi vai một admin khác → CANNOT_ACT_ON_MEMBER", async () => {
    roles({ [ACTOR]: "ADMIN", [TARGET]: "ADMIN" });

    await expect(
      organizationService.changeMemberRole(ORG, ACTOR, TARGET, "MEMBER"),
    ).rejects.toMatchObject({ statusResponse: { code: "CANNOT_ACT_ON_MEMBER" } });
  });

  it.each(["OWNER", "LEGAL_REPRESENTATIVE"])(
    "không ai đổi được vai của %s",
    async (targetRole) => {
      roles({ [ACTOR]: "OWNER", [TARGET]: targetRole });

      await expect(
        organizationService.changeMemberRole(ORG, ACTOR, TARGET, "MEMBER"),
      ).rejects.toMatchObject({ statusResponse: { code: "CANNOT_ACT_ON_MEMBER" } });
    },
  );

  it("member không có MEMBER_MANAGE → ORG_PERMISSION_DENIED", async () => {
    roles({ [ACTOR]: "MEMBER", [TARGET]: "MEMBER" });

    await expect(
      organizationService.changeMemberRole(ORG, ACTOR, TARGET, "CAMPAIGN_MANAGER"),
    ).rejects.toMatchObject({ statusResponse: { code: "ORG_PERMISSION_DENIED" } });
  });

  it("tự đổi vai của chính mình → CANNOT_ACT_ON_MEMBER", async () => {
    roles({ [ACTOR]: "ADMIN" });

    await expect(
      organizationService.changeMemberRole(ORG, ACTOR, ACTOR, "MEMBER"),
    ).rejects.toMatchObject({ statusResponse: { code: "CANNOT_ACT_ON_MEMBER" } });
  });

  it("người được đổi vai không còn trong tổ chức → MEMBER_NOT_FOUND", async () => {
    roles({ [ACTOR]: "OWNER" });

    await expect(
      organizationService.changeMemberRole(ORG, ACTOR, TARGET, "MEMBER"),
    ).rejects.toMatchObject({ statusResponse: { code: "MEMBER_NOT_FOUND" } });
  });

  it("gán lại đúng vai đang có thì không gửi thông báo", async () => {
    roles({ [ACTOR]: "OWNER", [TARGET]: "MEMBER" });

    await organizationService.changeMemberRole(ORG, ACTOR, TARGET, "MEMBER");

    expect(membershipChangedMock).not.toHaveBeenCalled();
  });
});

describe("OrganizationService.removeMember", () => {
  it("admin gỡ member: xoá mềm, ghi người gỡ, báo người bị gỡ", async () => {
    roles({ [ACTOR]: "ADMIN", [TARGET]: "MEMBER" });

    await organizationService.removeMember(ORG, ACTOR, TARGET);

    expect(softDeleteMembershipMock).toHaveBeenCalledWith(ORG, TARGET, ACTOR);
    expect(membershipChangedMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TARGET, removed: true }),
    );
  });

  it("admin gỡ admin khác → CANNOT_ACT_ON_MEMBER", async () => {
    roles({ [ACTOR]: "ADMIN", [TARGET]: "ADMIN" });

    await expect(organizationService.removeMember(ORG, ACTOR, TARGET)).rejects.toMatchObject(
      { statusResponse: { code: "CANNOT_ACT_ON_MEMBER" } },
    );
    expect(softDeleteMembershipMock).not.toHaveBeenCalled();
  });

  it("gỡ owner → CANNOT_ACT_ON_MEMBER (để phase 3)", async () => {
    roles({ [ACTOR]: "OWNER", [TARGET]: "OWNER" });

    await expect(organizationService.removeMember(ORG, ACTOR, TARGET)).rejects.toMatchObject(
      { statusResponse: { code: "CANNOT_ACT_ON_MEMBER" } },
    );
  });

  it("campaign manager gỡ member → ORG_PERMISSION_DENIED", async () => {
    roles({ [ACTOR]: "CAMPAIGN_MANAGER", [TARGET]: "MEMBER" });

    await expect(organizationService.removeMember(ORG, ACTOR, TARGET)).rejects.toMatchObject(
      { statusResponse: { code: "ORG_PERMISSION_DENIED" } },
    );
  });

  it("người bị gỡ không phải thành viên → MEMBER_NOT_FOUND", async () => {
    roles({ [ACTOR]: "OWNER" });

    await expect(organizationService.removeMember(ORG, ACTOR, TARGET)).rejects.toMatchObject(
      { statusResponse: { code: "MEMBER_NOT_FOUND" } },
    );
  });
});

describe("OrganizationService.processJoinRequest — quyền duyệt", () => {
  const request = {
    id: "jr-1",
    organizationId: ORG,
    requesterId: TARGET,
    status: 12,
    organization: { id: ORG, name: "CLB Xanh", slug: "clb-xanh", deletedAt: null },
  };

  beforeEach(() => {
    findByIdWithOrganizationMock.mockResolvedValue(request);
    joinFindByIdMock.mockResolvedValue({ ...request, status: 14 });
  });

  it("admin duyệt được: cấp vai MEMBER qua grantMembership trong transaction", async () => {
    roles({ [ACTOR]: "ADMIN" });

    await organizationService.processJoinRequest("jr-1", ACTOR, 14 as never);

    expect(txFake.organizationJoiningRequest.update).toHaveBeenCalled();
    expect(grantMembershipMock.mock.calls[0][1]).toMatchObject({
      userId: TARGET,
      organizationId: ORG,
      role: "MEMBER",
      source: "JOIN_REQUEST",
      sourceRef: "jr-1",
    });
  });

  it("member không duyệt được → ORG_PERMISSION_DENIED", async () => {
    roles({ [ACTOR]: "MEMBER" });

    await expect(
      organizationService.processJoinRequest("jr-1", ACTOR, 14 as never),
    ).rejects.toMatchObject({ statusResponse: { code: "ORG_PERMISSION_DENIED" } });
    expect(grantMembershipMock).not.toHaveBeenCalled();
  });
});

describe("OrganizationService.updateOrganization — quyền sửa hồ sơ", () => {
  it("admin sửa được hồ sơ tổ chức", async () => {
    roles({ [ACTOR]: "ADMIN" });

    await organizationService.updateOrganization(ORG, ACTOR, { name: "CLB Xanh Mới" });

    expect(orgUpdateMock.mock.calls[0][1]).toMatchObject({ name: "CLB Xanh Mới" });
  });

  it("campaign manager không sửa được → ORG_PERMISSION_DENIED", async () => {
    roles({ [ACTOR]: "CAMPAIGN_MANAGER" });

    await expect(
      organizationService.updateOrganization(ORG, ACTOR, { name: "X" }),
    ).rejects.toMatchObject({ statusResponse: { code: "ORG_PERMISSION_DENIED" } });
    expect(orgUpdateMock).not.toHaveBeenCalled();
  });
});
