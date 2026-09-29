jest.mock("../../organization/organization_member.repository", () => ({
  organizationMemberRepository: {},
}));

import { computeCreateEligibility } from "../campaign-eligibility.service";

const org = (o: Partial<{ status: number; trustTier: string; tickSuspended: boolean }> = {}) => ({
  id: "org-1",
  status: 1,
  trustTier: "VERIFIED",
  tickSuspended: false,
  ...o,
});

describe("computeCreateEligibility", () => {
  it("verified organization: no difficulty or open limit", () => {
    const e = computeCreateEligibility({
      org: org(),
      role: "OWNER",
      openCount: 10,
      reviewQueueCount: 0,
    });
    expect(e).toMatchObject({ canCreate: true, hidden: false, isVerified: true, maxDifficulty: null });
  });

  it("unverified (or suspended tick): lowest difficulty, 2 open campaigns", () => {
    for (const o of [org({ trustTier: "BASIC" }), org({ tickSuspended: true })]) {
      const ok = computeCreateEligibility({ org: o, role: "OWNER", openCount: 1, reviewQueueCount: 0 });
      expect(ok).toMatchObject({ canCreate: true, isVerified: false, maxDifficulty: 1, openLimit: 2 });
      const full = computeCreateEligibility({ org: o, role: "OWNER", openCount: 2, reviewQueueCount: 0 });
      expect(full.reasons).toEqual(["UNVERIFIED_OPEN_LIMIT"]);
    }
  });

  it("at most 3 campaigns waiting for review or changes", () => {
    const e = computeCreateEligibility({ org: org(), role: "CAMPAIGN_MANAGER", openCount: 0, reviewQueueCount: 3 });
    expect(e).toMatchObject({ canCreate: false, reasons: ["REVIEW_QUEUE_FULL"] });
  });

  it("locked organization cannot create", () => {
    const e = computeCreateEligibility({ org: org({ status: 2 }), role: "OWNER", openCount: 0, reviewQueueCount: 0 });
    expect(e.reasons).toContain("ORG_LOCKED");
  });

  it.each(["ADMIN", "MEMBER", null])("role %s: the button is hidden", (role) => {
    const e = computeCreateEligibility({ org: org(), role, openCount: 0, reviewQueueCount: 0 });
    expect(e).toMatchObject({ canCreate: false, hidden: true });
  });
});
