/**
 * Ma trận quyền trong tổ chức (`@da2/constants/org-permissions`) là nguồn duy nhất: server
 * enforce theo nó, client nhận `permissions` resolve từ nó. Sai một ô là mở quyền cho cả
 * hệ thống, nên kiểm từng ô.
 */
import {
  OrgMemberRole,
  OrgPermission,
  assignableRoles,
  canActOnMember,
  hasOrgPermission,
  permissionsFor,
} from "@da2/constants";

const { LEGAL_REPRESENTATIVE: LR, OWNER, ADMIN, CAMPAIGN_MANAGER: CM, MEMBER } =
  OrgMemberRole;

describe("hasOrgPermission — ma trận 5 cấp", () => {
  const matrix: [OrgPermission, OrgMemberRole[]][] = [
    [OrgPermission.ORG_EDIT, [LR, OWNER, ADMIN]],
    [OrgPermission.MEMBER_APPROVE, [LR, OWNER, ADMIN]],
    [OrgPermission.MEMBER_INVITE, [LR, OWNER, ADMIN, CM, MEMBER]],
    [OrgPermission.MEMBER_MANAGE, [LR, OWNER, ADMIN]],
    [OrgPermission.OWNER_PROPOSE, [LR, OWNER]],
    [OrgPermission.CAMPAIGN_CREATE, [LR, OWNER, ADMIN, CM]],
    [OrgPermission.CAMPAIGN_MANAGE_ANY, [LR, OWNER, ADMIN]],
  ];

  it.each(matrix)("%s chỉ dành cho %j", (permission, allowed) => {
    for (const role of [LR, OWNER, ADMIN, CM, MEMBER]) {
      expect(hasOrgPermission(role, permission)).toBe(allowed.includes(role));
    }
  });

  it("không phải thành viên (null) hoặc vai lạ thì không có quyền gì", () => {
    for (const permission of Object.values(OrgPermission)) {
      expect(hasOrgPermission(null, permission)).toBe(false);
      expect(hasOrgPermission("SUPERUSER", permission)).toBe(false);
    }
  });
});

describe("assignableRoles", () => {
  it("owner và người đại diện gán được ADMIN / CAMPAIGN_MANAGER / MEMBER, không gán owner", () => {
    for (const actor of [OWNER, LR]) {
      expect(assignableRoles(actor)).toEqual([ADMIN, CM, MEMBER]);
    }
  });

  it("admin chỉ gán được CAMPAIGN_MANAGER / MEMBER — không tự nâng ai lên ADMIN", () => {
    expect(assignableRoles(ADMIN)).toEqual([CM, MEMBER]);
  });

  it("campaign manager, member, người ngoài không gán được gì", () => {
    expect(assignableRoles(CM)).toEqual([]);
    expect(assignableRoles(MEMBER)).toEqual([]);
    expect(assignableRoles(null)).toEqual([]);
  });
});

describe("canActOnMember", () => {
  it("không ai đổi vai / gỡ được owner hay người đại diện ở phase này", () => {
    for (const actor of [LR, OWNER, ADMIN]) {
      expect(canActOnMember(actor, OWNER)).toBe(false);
      expect(canActOnMember(actor, LR)).toBe(false);
    }
  });

  it("owner tác động được admin, campaign manager, member", () => {
    for (const target of [ADMIN, CM, MEMBER]) {
      expect(canActOnMember(OWNER, target)).toBe(true);
    }
  });

  it("admin không đụng được admin khác, nhưng được campaign manager và member", () => {
    expect(canActOnMember(ADMIN, ADMIN)).toBe(false);
    expect(canActOnMember(ADMIN, CM)).toBe(true);
    expect(canActOnMember(ADMIN, MEMBER)).toBe(true);
  });

  it("không có MEMBER_MANAGE thì không tác động được ai; target không phải thành viên cũng vậy", () => {
    expect(canActOnMember(CM, MEMBER)).toBe(false);
    expect(canActOnMember(MEMBER, MEMBER)).toBe(false);
    expect(canActOnMember(OWNER, null)).toBe(false);
  });
});

describe("permissionsFor", () => {
  it("owner có đủ mọi quyền kèm danh sách vai gán được", () => {
    expect(permissionsFor(OWNER)).toEqual({
      canEditOrg: true,
      canApproveMembers: true,
      canInvite: true,
      canManageMembers: true,
      canProposeOwners: true,
      canCreateCampaign: true,
      canManageAllCampaigns: true,
      assignableRoles: [ADMIN, CM, MEMBER],
    });
  });

  it("member chỉ được mời", () => {
    expect(permissionsFor(MEMBER)).toEqual({
      canEditOrg: false,
      canApproveMembers: false,
      canInvite: true,
      canManageMembers: false,
      canProposeOwners: false,
      canCreateCampaign: false,
      canManageAllCampaigns: false,
      assignableRoles: [],
    });
  });

  it("người ngoài: tất cả false", () => {
    const perms = permissionsFor(null);
    expect(Object.entries(perms).filter(([, v]) => v === true)).toEqual([]);
    expect(perms.assignableRoles).toEqual([]);
  });
});
