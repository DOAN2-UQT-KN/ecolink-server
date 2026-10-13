import { isOrganizationVerified } from "@da2/constants";

const NOW = new Date("2026-09-30T00:00:00.000Z");
const verified = {
  trustTier: "VERIFIED",
  tickSuspended: false,
  kycStatus: "APPROVED",
  verificationExpiresAt: null as Date | string | null,
};

describe("isOrganizationVerified (Blue Tick rule)", () => {
  it("lane A: verified tier, approved KYC, no expiry", () => {
    expect(isOrganizationVerified(verified, NOW)).toBe(true);
  });

  it("lane B: valid until verificationExpiresAt", () => {
    expect(
      isOrganizationVerified({ ...verified, verificationExpiresAt: "2026-10-01T00:00:00Z" }, NOW),
    ).toBe(true);
    expect(
      isOrganizationVerified({ ...verified, verificationExpiresAt: new Date("2026-09-29") }, NOW),
    ).toBe(false);
  });

  it.each([
    ["tier NONE", { trustTier: "NONE" }],
    ["tier BASIC", { trustTier: "BASIC" }],
    ["suspended tick", { tickSuspended: true }],
    ["KYC not submitted", { kycStatus: "NOT_SUBMITTED" }],
    ["KYC expired", { kycStatus: "EXPIRED" }],
    ["KYC revoked", { kycStatus: "REVOKED" }],
  ])("%s → not verified", (_label, change) => {
    expect(isOrganizationVerified({ ...verified, ...change }, NOW)).toBe(false);
  });
});
