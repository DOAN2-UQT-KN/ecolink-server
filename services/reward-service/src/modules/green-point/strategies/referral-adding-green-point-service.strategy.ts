import { Prisma } from "@prisma/client";
import { applyGreenPointLedgerCredit } from "../green-point-ledger.util";
import {
  GreenPointResourceType,
  GreenPointTransactionType,
} from "../green-point-transaction.constants";
import {
  REFERRAL_ADDING_GREEN_POINT_JOB_TYPE,
  type ReferralAddingGreenPointsPayload,
} from "../green-point.types";
import type {
  GreenPointApplyResult,
  GreenPointCreditStrategy,
} from "./green-point-credit-strategy.types";

export class ReferralAddingGreenPointServiceStrategy
  implements GreenPointCreditStrategy<ReferralAddingGreenPointsPayload>
{
  readonly queueJobType = REFERRAL_ADDING_GREEN_POINT_JOB_TYPE;

  validatePayload(raw: unknown): ReferralAddingGreenPointsPayload {
    if (raw === null || typeof raw !== "object") {
      throw new Error("Referral green point payload must be an object");
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
    return {
      userId: p.userId,
      points: p.points,
      resourceId: p.resourceId,
    };
  }

  async applyInTransaction(
    tx: Prisma.TransactionClient,
    payload: ReferralAddingGreenPointsPayload,
  ): Promise<GreenPointApplyResult> {
    const outcome = await applyGreenPointLedgerCredit(tx, {
      userId: payload.userId,
      points: payload.points,
      transactionType: GreenPointTransactionType.REFERRAL,
      resourceId: payload.resourceId,
      resourceType: GreenPointResourceType.USER,
    });
    return outcome === "credited"
      ? { credited: 1, skipped: 0 }
      : { credited: 0, skipped: 1 };
  }
}
