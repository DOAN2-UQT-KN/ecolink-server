import { Prisma } from "@prisma/client";
import {
  loadActivePointRules,
  type PointRulesSnapshot,
} from "../../gamification/gamification-config.service";
import { applyResolvedCredits, warnNoPointRules } from "../green-point-ledger.util";
import { GreenPointResourceType, GreenPointTransactionType } from "../green-point-transaction.constants";
import {
  REPORT_COMPLETION_GREEN_POINT_JOB_TYPE,
  type ReportCompletionGreenPointsPayload,
} from "../green-point.types";
import type {
  GreenPointApplyResult,
  GreenPointCreditStrategy,
  ResolvedCredit,
} from "./green-point-credit-strategy.types";

/** One credit of the configured report-completion points; none when the rate is 0 (FR-006). */
export function resolveReportCompletionCredits(
  payload: ReportCompletionGreenPointsPayload,
  rules: PointRulesSnapshot,
): ResolvedCredit[] {
  if (rules.reportCompletionPoints <= 0) return [];
  return [
    {
      userId: payload.userId,
      points: rules.reportCompletionPoints,
      transactionType: GreenPointTransactionType.REPORT_COMPLETION,
      resourceId: payload.reportId,
      resourceType: GreenPointResourceType.REPORT,
      metadata: { ruleId: rules.id, reportCompletionPoints: rules.reportCompletionPoints },
    },
  ];
}

export class ReportCompletionGreenPointStrategy
  implements GreenPointCreditStrategy<ReportCompletionGreenPointsPayload>
{
  readonly queueJobType = REPORT_COMPLETION_GREEN_POINT_JOB_TYPE;

  /** A legacy payload's `points` is ignored: the rules decide the amount. */
  validatePayload(raw: unknown): ReportCompletionGreenPointsPayload {
    if (raw === null || typeof raw !== "object") {
      throw new Error("Report completion green point payload must be an object");
    }
    const p = raw as Record<string, unknown>;
    if (typeof p.reportId !== "string" || !p.reportId) {
      throw new Error("reportId is required");
    }
    if (typeof p.userId !== "string" || !p.userId) {
      throw new Error("userId is required");
    }
    return { reportId: p.reportId, userId: p.userId };
  }

  async applyInTransaction(
    tx: Prisma.TransactionClient,
    payload: ReportCompletionGreenPointsPayload,
  ): Promise<GreenPointApplyResult> {
    const rules = await loadActivePointRules(tx);
    if (!rules) return warnNoPointRules(this.queueJobType, payload.reportId);
    return applyResolvedCredits(tx, resolveReportCompletionCredits(payload, rules));
  }
}
