import { Prisma } from "@prisma/client";
import { applyGreenPointLedgerCredit } from "../green-point-ledger.util";
import { GreenPointTransactionType } from "../green-point-transaction.constants";
import {
  UPVOTE_ADDING_GREEN_POINT_JOB_TYPE,
  type UpvoteAddingGreenPointsPayload,
} from "../green-point.types";
import type {
  GreenPointApplyResult,
  GreenPointCreditStrategy,
} from "./green-point-credit-strategy.types";

export class UpvoteAddingGreenPointStrategy
  implements GreenPointCreditStrategy<UpvoteAddingGreenPointsPayload>
{
  readonly queueJobType = UPVOTE_ADDING_GREEN_POINT_JOB_TYPE;

  validatePayload(raw: unknown): UpvoteAddingGreenPointsPayload {
    if (raw === null || typeof raw !== "object") {
      throw new Error("Upvote green point payload must be an object");
    }
    const p = raw as Record<string, unknown>;
    if (typeof p.userId !== "string" || !p.userId) {
      throw new Error("userId is required");
    }
    if (typeof p.points !== "number" || Number.isNaN(p.points)) {
      throw new Error("points must be a number");
    }
    if (typeof p.resourceId !== "string" || !p.resourceId) {
      throw new Error("resourceId is required");
    }
    if (typeof p.resourceType !== "string" || !p.resourceType.trim()) {
      throw new Error("resourceType is required");
    }
    return {
      userId: p.userId,
      points: p.points,
      resourceId: p.resourceId,
      resourceType: p.resourceType.trim(),
    };
  }

  async applyInTransaction(
    tx: Prisma.TransactionClient,
    payload: UpvoteAddingGreenPointsPayload,
  ): Promise<GreenPointApplyResult> {
    const outcome = await applyGreenPointLedgerCredit(tx, {
      userId: payload.userId,
      points: payload.points,
      transactionType: GreenPointTransactionType.UPVOTE,
      resourceId: payload.resourceId,
      resourceType: payload.resourceType,
    });
    return outcome === "credited"
      ? { credited: 1, skipped: 0 }
      : { credited: 0, skipped: 1 };
  }
}
