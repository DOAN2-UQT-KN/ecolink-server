import { GlobalStatus } from "./status.enum";

/** Report lifecycle states used by the verification pipeline (specs/006 research R1). */
export const REPORT_STATUS_PENDING_VERIFICATION = GlobalStatus._STATUS_PENDING;
export const REPORT_STATUS_IN_REVIEW = GlobalStatus._STATUS_INREVIEW;
export const REPORT_STATUS_ACCEPTED = GlobalStatus._STATUS_TODO;
export const REPORT_STATUS_REJECTED = GlobalStatus._STATUS_INACTIVE;

/** The only reason codes a check or the risk engine may emit. */
export const REASON_CODES = [
  "DUP_NEAR_IMAGE_MATCH",
  "DUP_FEATURE_MATCH",
  "DUP_WEB_IMAGE_MATCH",
  "TRUST_NOT_LIVE_CAPTURE",
  "TRUST_HIGH_REJECT_RATE",
  "TRUST_NEW_ACCOUNT",
  "CTX_CATEGORY_LOCATION_MISMATCH",
  "SYS_CHECK_FAILED_DUPLICATE",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** Reasons never shown to the report owner (they reveal scoring internals). */
export const ADMIN_ONLY_REASONS: ReadonlySet<string> = new Set<ReasonCode>([
  "TRUST_HIGH_REJECT_RATE",
  "TRUST_NEW_ACCOUNT",
  "SYS_CHECK_FAILED_DUPLICATE",
]);

export function isAdminOnlyReason(code: string): boolean {
  return code.startsWith("SYS_") || ADMIN_ONLY_REASONS.has(code);
}
