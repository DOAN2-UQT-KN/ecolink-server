import { Prisma } from "@prisma/client";
import {
  loadActivePointRules,
  type PointRulesSnapshot,
} from "../../gamification/gamification-config.service";
import { applyResolvedCredits, warnNoPointRules } from "../green-point-ledger.util";
import { GreenPointTransactionType } from "../green-point-transaction.constants";
import {
  REPORT_VOTE_MILESTONE_GREEN_POINT_JOB_TYPE,
  type ReportVoteMilestoneGreenPointsPayload,
} from "../green-point.types";
import type {
  GreenPointApplyResult,
  GreenPointCreditStrategy,
  ResolvedCredit,
} from "./green-point-credit-strategy.types";

export const REPORT_VOTE_MILESTONE_RESOURCE_PREFIX = "REPORT_VOTE_MILESTONE_";

function encodeMilestoneResourceType(threshold: number): string {
  // Per-report idempotency key: one payout per (report, threshold). Moves to idempotency_key in step 2.
  return `${REPORT_VOTE_MILESTONE_RESOURCE_PREFIX}${threshold}`;
}

/**
 * Every milestone reached (threshold <= voteCount): the i-th (1-based, ascending) pays
 * base × i. Already-paid milestones are dropped by the ledger's unique key.
 */
export function resolveReportVoteMilestoneCredits(
  payload: ReportVoteMilestoneGreenPointsPayload,
  rules: PointRulesSnapshot,
): ResolvedCredit[] {
  if (rules.baseReportPoint <= 0 || payload.voteCount <= 0) return [];
  const sorted = [...rules.reportMilestoneThresholds].sort((a, b) => a - b);
  return sorted.flatMap((threshold, index) => {
    if (threshold > payload.voteCount) return [];
    const milestoneIndex = index + 1;
    return [
      {
        userId: payload.reportCreatorUserId,
        points: rules.baseReportPoint * milestoneIndex,
        transactionType: GreenPointTransactionType.REPORT_VOTE_MILESTONE,
        resourceId: payload.reportId,
        resourceType: encodeMilestoneResourceType(threshold),
        metadata: {
          ruleId: rules.id,
          baseReportPoint: rules.baseReportPoint,
          threshold,
          milestoneIndex,
          voteCountAtAward: payload.voteCount,
        },
      },
    ];
  });
}

export class ReportVoteMilestoneGreenPointStrategy
  implements GreenPointCreditStrategy<ReportVoteMilestoneGreenPointsPayload>
{
  readonly queueJobType = REPORT_VOTE_MILESTONE_GREEN_POINT_JOB_TYPE;

  validatePayload(raw: unknown): ReportVoteMilestoneGreenPointsPayload {
    if (raw === null || typeof raw !== "object") {
      throw new Error("Report vote milestone payload must be an object");
    }
    const p = raw as Record<string, unknown>;
    if (typeof p.reportId !== "string" || !p.reportId) {
      throw new Error("reportId is required");
    }
    if (typeof p.reportCreatorUserId !== "string" || !p.reportCreatorUserId) {
      throw new Error("reportCreatorUserId is required");
    }
    if (
      typeof p.voteCount !== "number" ||
      !Number.isFinite(p.voteCount) ||
      p.voteCount < 0
    ) {
      throw new Error("voteCount must be a non-negative number");
    }
    return {
      reportId: p.reportId,
      reportCreatorUserId: p.reportCreatorUserId,
      voteCount: p.voteCount,
    };
  }

  async applyInTransaction(
    tx: Prisma.TransactionClient,
    payload: ReportVoteMilestoneGreenPointsPayload,
  ): Promise<GreenPointApplyResult> {
    const rules = await loadActivePointRules(tx);
    if (!rules) return warnNoPointRules(this.queueJobType, payload.reportId);
    return applyResolvedCredits(tx, resolveReportVoteMilestoneCredits(payload, rules));
  }
}
