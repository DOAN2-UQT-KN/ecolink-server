import { Prisma } from "@prisma/client";
import { applyGreenPointLedgerCredit } from "../green-point-ledger.util";
import { GreenPointTransactionType } from "../green-point-transaction.constants";
import {
  REPORT_VOTE_MILESTONE_GREEN_POINT_JOB_TYPE,
  type ReportVoteMilestoneGreenPointsPayload,
} from "../green-point.types";
import type {
  GreenPointApplyResult,
  GreenPointCreditStrategy,
} from "./green-point-credit-strategy.types";

function encodeRuleResourceType(threshold: number): string {
  // Keep under VARCHAR(64) and stable for idempotency unique index.
  return `REPORT_VOTE_MILESTONE_${threshold}`;
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
    const rules = await tx.$queryRaw<
      Array<{ id: string; threshold: number; points: number }>
    >(
      Prisma.sql`
        SELECT id, threshold, points
        FROM "report_vote_green_point_rules"
        WHERE "is_active" = true
        ORDER BY threshold ASC
      `,
    );

    let credited = 0;
    let skipped = 0;

    for (const rule of rules) {
      if (rule.threshold > payload.voteCount) break;

      const outcome = await applyGreenPointLedgerCredit(tx, {
        userId: payload.reportCreatorUserId,
        points: rule.points,
        transactionType: GreenPointTransactionType.REPORT_VOTE_MILESTONE,
        resourceId: payload.reportId,
        // Use resourceType as part of idempotency key to allow multiple thresholds per report.
        resourceType: encodeRuleResourceType(rule.threshold),
        metadata: {
          threshold: rule.threshold,
          ruleId: rule.id,
          voteCountAtAward: payload.voteCount,
        },
      });

      if (outcome === "credited") credited += 1;
      else skipped += 1;
    }

    return { credited, skipped };
  }
}

