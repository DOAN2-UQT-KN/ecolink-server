import {
  isAdminOnlyReason,
  REPORT_STATUS_ACCEPTED,
  REPORT_STATUS_IN_REVIEW,
  REPORT_STATUS_PENDING_VERIFICATION,
  REPORT_STATUS_REJECTED,
} from "../report-verification";

describe("report-verification constants", () => {
  it("maps verification states onto GlobalStatus numbers", () => {
    expect(REPORT_STATUS_PENDING_VERIFICATION).toBe(12);
    expect(REPORT_STATUS_IN_REVIEW).toBe(9);
    expect(REPORT_STATUS_ACCEPTED).toBe(21);
    expect(REPORT_STATUS_REJECTED).toBe(2);
  });

  it.each(["SYS_CHECK_FAILED_DUPLICATE", "SYS_ANYTHING_NEW", "TRUST_NEW_ACCOUNT", "TRUST_HIGH_REJECT_RATE"])(
    "%s is admin-only",
    (code) => expect(isAdminOnlyReason(code)).toBe(true),
  );

  it.each(["DUP_NEAR_IMAGE_MATCH", "TRUST_NOT_LIVE_CAPTURE", "CTX_CATEGORY_LOCATION_MISMATCH"])(
    "%s is visible to the owner",
    (code) => expect(isAdminOnlyReason(code)).toBe(false),
  );
});
