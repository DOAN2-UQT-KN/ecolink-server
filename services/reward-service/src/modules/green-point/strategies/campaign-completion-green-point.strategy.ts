import { Prisma } from "@prisma/client";
import { applyGreenPointLedgerCredit } from "../green-point-ledger.util";
import {
  GreenPointResourceType,
  GreenPointTransactionType,
} from "../green-point-transaction.constants";
import { CAMPAIGN_COMPLETION_JOB_TYPE } from "../green-point.types";
import type { CampaignCompletionGreenPointsPayload } from "../green-point.types";
import type {
  GreenPointApplyResult,
  GreenPointCreditStrategy,
} from "./green-point-credit-strategy.types";

export class CampaignCompletionGreenPointStrategy
  implements GreenPointCreditStrategy<CampaignCompletionGreenPointsPayload>
{
  readonly queueJobType = CAMPAIGN_COMPLETION_JOB_TYPE;

  validatePayload(raw: unknown): CampaignCompletionGreenPointsPayload {
    if (raw === null || typeof raw !== "object") {
      throw new Error("Campaign completion payload must be an object");
    }
    const p = raw as Record<string, unknown>;
    if (typeof p.campaignId !== "string" || p.campaignId.length === 0) {
      throw new Error("campaignId is required");
    }
    if (!Array.isArray(p.credits)) {
      throw new Error("credits must be an array");
    }
    for (const row of p.credits) {
      if (row === null || typeof row !== "object") {
        throw new Error("Each credit must be an object");
      }
      const c = row as Record<string, unknown>;
      if (typeof c.userId !== "string" || typeof c.points !== "number") {
        throw new Error("Each credit needs userId (string) and points (number)");
      }
    }
    return raw as CampaignCompletionGreenPointsPayload;
  }

  async applyInTransaction(
    tx: Prisma.TransactionClient,
    payload: CampaignCompletionGreenPointsPayload,
  ): Promise<GreenPointApplyResult> {
    const { campaignId, credits } = payload;
    let credited = 0;
    let skipped = 0;

    for (const row of credits) {
      const outcome = await applyGreenPointLedgerCredit(tx, {
        userId: row.userId,
        points: row.points,
        transactionType: GreenPointTransactionType.CAMPAIGN_COMPLETION,
        resourceId: campaignId,
        resourceType: GreenPointResourceType.CAMPAIGN,
      });
      if (outcome === "credited") {
        credited++;
      } else {
        skipped++;
      }
    }

    return { credited, skipped };
  }
}
