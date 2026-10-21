import type { PointSourceType } from "@prisma/client";
import { GreenPointResourceType } from "../green-point/green-point-transaction.constants";

const REPORT_VOTE_MILESTONE_PREFIX = "REPORT_VOTE_MILESTONE_";

/**
 * Report-sourced ledger rows: plain REPORT and vote milestones, whose resource_type still encodes
 * the threshold for idempotency (spec 013 R6) while resource_id is the report.
 */
export function isReportResourceType(resourceType: string): boolean {
  return (
    resourceType === GreenPointResourceType.REPORT ||
    resourceType.startsWith(REPORT_VOTE_MILESTONE_PREFIX)
  );
}

export function mapResourceTypeToSourceType(
  resourceType: string,
): PointSourceType {
  if (resourceType === GreenPointResourceType.CAMPAIGN) {
    return "CAMPAIGN";
  }
  if (isReportResourceType(resourceType)) {
    return "REPORT";
  }
  return "SYSTEM";
}
