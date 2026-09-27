const findActiveRoleMock = jest.fn();
const findActiveRolesForUserMock = jest.fn();
const isManagerMock = jest.fn();
const isVolunteerApprovedMock = jest.fn();
const findCampaignMock = jest.fn();

jest.mock("../../organization/organization_member.repository", () => ({
  organizationMemberRepository: {
    findActiveRole: (...a: unknown[]) => findActiveRoleMock(...a),
    findActiveRolesForUser: (...a: unknown[]) => findActiveRolesForUserMock(...a),
  },
}));
jest.mock("../campaign_manager/campaign_manager.repository", () => ({
  campaignManagerRepository: { isManager: (...a: unknown[]) => isManagerMock(...a) },
}));
jest.mock("../campaign_joining_request/campaign_joining_request.repository", () => ({
  campaignJoiningRequestRepository: {
    isVolunteerApproved: (...a: unknown[]) => isVolunteerApprovedMock(...a),
  },
}));
jest.mock("../campaign.repository", () => ({
  campaignRepository: { findById: (...a: unknown[]) => findCampaignMock(...a) },
}));

import { OrgMemberRole } from "@da2/constants";
import { campaignAccessService, isPlatformAdmin } from "../campaign-access.service";

const ORG = "org-1";
const CREATOR = "creator";
const campaign = { id: "camp-1", organizationId: ORG, createdBy: CREATOR };

beforeEach(() => {
  jest.clearAllMocks();
  findCampaignMock.mockResolvedValue(campaign);
  isManagerMock.mockResolvedValue(false);
  isVolunteerApprovedMock.mockResolvedValue(false);
});

describe("campaignAccessService.compute", () => {
  const cases: Array<[string, string, string | null, boolean, boolean, boolean]> = [
    // label, userId, org role, isManager → canManage, canDelete
    ["creator still a member", CREATOR, OrgMemberRole.MEMBER, false, true, true],
    ["assigned manager", "m", OrgMemberRole.MEMBER, true, true, false],
    ["legal representative", "lr", OrgMemberRole.LEGAL_REPRESENTATIVE, false, true, true],
    ["owner", "o", OrgMemberRole.OWNER, false, true, true],
    ["org admin", "a", OrgMemberRole.ADMIN, false, false, false],
    ["campaign manager role, not assigned", "cm", OrgMemberRole.CAMPAIGN_MANAGER, false, false, false],
    ["plain member", "u", OrgMemberRole.MEMBER, false, false, false],
    ["outsider", "x", null, false, false, false],
    ["creator who left the organization", CREATOR, null, false, false, false],
    ["manager who left the organization", "m", null, true, false, false],
  ];
  it.each(cases)("%s", (_label, userId, role, isManager, canManage, canDelete) => {
    const access = campaignAccessService.compute(campaign, userId, role, isManager);
    expect(access.canManage).toBe(canManage);
    expect(access.canDelete).toBe(canDelete);
  });
});

describe("campaignAccessService.assert*", () => {
  it("lets an owner manage a campaign someone else created", async () => {
    findActiveRoleMock.mockResolvedValue(OrgMemberRole.OWNER);
    await expect(campaignAccessService.assertCanManage("camp-1", "owner")).resolves.toEqual(
      campaign,
    );
  });

  it("refuses an org admin with CAMPAIGN_PERMISSION_DENIED", async () => {
    findActiveRoleMock.mockResolvedValue(OrgMemberRole.ADMIN);
    await expect(
      campaignAccessService.assertCanManage("camp-1", "admin"),
    ).rejects.toMatchObject({ statusResponse: expect.objectContaining({ code: "CAMPAIGN_PERMISSION_DENIED" }) });
  });

  it("does not let a manager delete the campaign", async () => {
    findActiveRoleMock.mockResolvedValue(OrgMemberRole.MEMBER);
    isManagerMock.mockResolvedValue(true);
    await expect(campaignAccessService.assertCanDelete("camp-1", "m")).rejects.toBeDefined();
  });

  it("404s on a missing campaign", async () => {
    findCampaignMock.mockResolvedValue(null);
    await expect(campaignAccessService.assertCanManage("nope", "u")).rejects.toMatchObject({
      statusResponse: expect.objectContaining({ status: 404 }),
    });
  });
});

describe("campaignAccessService.assertCanViewVolunteers", () => {
  it("allows an approved volunteer", async () => {
    findActiveRoleMock.mockResolvedValue(null);
    isVolunteerApprovedMock.mockResolvedValue(true);
    await expect(
      campaignAccessService.assertCanViewVolunteers("camp-1", "vol"),
    ).resolves.toBeUndefined();
  });

  it("allows a platform admin without any membership", async () => {
    await expect(
      campaignAccessService.assertCanViewVolunteers("camp-1", "root", "Admin"),
    ).resolves.toBeUndefined();
    expect(findActiveRoleMock).not.toHaveBeenCalled();
  });

  it("refuses anyone else", async () => {
    findActiveRoleMock.mockResolvedValue(OrgMemberRole.MEMBER);
    await expect(
      campaignAccessService.assertCanViewVolunteers("camp-1", "someone"),
    ).rejects.toBeDefined();
  });
});

describe("campaignAccessService.resolveMany", () => {
  it("reads roles once for the whole list", async () => {
    findActiveRolesForUserMock.mockResolvedValue(new Map([[ORG, OrgMemberRole.OWNER]]));
    const result = await campaignAccessService.resolveMany(
      [
        { ...campaign, managerIds: [] },
        { id: "camp-2", organizationId: "other-org", createdBy: "u", managerIds: ["u"] },
      ],
      "u",
    );
    expect(findActiveRolesForUserMock).toHaveBeenCalledTimes(1);
    expect(result.get("camp-1")?.canManage).toBe(true);
    // A manager row without membership in that organization grants nothing.
    expect(result.get("camp-2")?.canManage).toBe(false);
  });
});

it("isPlatformAdmin is case-insensitive", () => {
  expect(isPlatformAdmin("ADMIN")).toBe(true);
  expect(isPlatformAdmin("user")).toBe(false);
  expect(isPlatformAdmin(undefined)).toBe(false);
});
