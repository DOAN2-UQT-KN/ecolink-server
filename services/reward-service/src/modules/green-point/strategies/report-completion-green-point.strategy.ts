import { Prisma } from "@prisma/client";
import { applyGreenPointLedgerCredit } from "../green-point-ledger.util";
import { GreenPointResourceType, GreenPointTransactionType } from "../green-point-transaction.constants";
import {
  REPORT_COMPLETION_GREEN_POINT_JOB_TYPE,
  type ReportCompletionGreenPointsPayload,
} from "../green-point.types";
import type {
  GreenPointApplyResult,
  GreenPointCreditStrategy,
} from "./green-point-credit-strategy.types";

export class ReportCompletionGreenPointStrategy
  implements GreenPointCreditStrategy<ReportCompletionGreenPointsPayload>
{
  readonly queueJobType = REPORT_COMPLETION_GREEN_POINT_JOB_TYPE;

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
    if (typeof p.points !== "number" || Number.isNaN(p.points)) {
      throw new Error("points must be a number");
    }
    return {
      reportId: p.reportId,
      userId: p.userId,
      points: p.points,
    };
  }

  async applyInTransaction(
    tx: Prisma.TransactionClient,
    payload: ReportCompletionGreenPointsPayload,
  ): Promise<GreenPointApplyResult> {
    const outcome = await applyGreenPointLedgerCredit(tx, {
      userId: payload.userId,
      points: payload.points,
      transactionType: GreenPointTransactionType.REPORT_COMPLETION,
      resourceId: payload.reportId,
      resourceType: GreenPointResourceType.REPORT,
    });
    return outcome === "credited"
      ? { credited: 1, skipped: 0 }
      : { credited: 0, skipped: 1 };
  }
}

