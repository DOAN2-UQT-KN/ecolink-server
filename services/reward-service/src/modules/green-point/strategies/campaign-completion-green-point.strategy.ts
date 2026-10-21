import { Prisma } from "@prisma/client";
import {
  loadActivePointRules,
  type PointRulesSnapshot,
} from "../../gamification/gamification-config.service";
import { applyResolvedCredits, warnNoPointRules } from "../green-point-ledger.util";
import {
  GreenPointResourceType,
  GreenPointTransactionType,
} from "../green-point-transaction.constants";
import { CAMPAIGN_COMPLETION_JOB_TYPE } from "../green-point.types";
import type {
  CampaignCompletionGreenPointsPayload,
  LegacyCampaignCompletionGreenPointsPayload,
} from "../green-point.types";
import type {
  GreenPointApplyResult,
  GreenPointCreditStrategy,
  ResolvedCredit,
} from "./green-point-credit-strategy.types";

type AnyCampaignCompletionPayload =
  | CampaignCompletionGreenPointsPayload
  | LegacyCampaignCompletionGreenPointsPayload;

function isLegacy(
  payload: AnyCampaignCompletionPayload,
): payload is LegacyCampaignCompletionGreenPointsPayload {
  return "credits" in payload;
}

function credit(campaignId: string, userId: string, points: number, metadata: Prisma.InputJsonValue): ResolvedCredit {
  return {
    userId,
    points,
    transactionType: GreenPointTransactionType.CAMPAIGN_COMPLETION,
    resourceId: campaignId,
    resourceType: GreenPointResourceType.CAMPAIGN,
    metadata,
  };
}

/**
 * Spec 013 FR-012: round(campaign points × min(1, eligible / max(1, registered))), zero dropped.
 * A legacy payload keeps the points incident-service already computed.
 */
export function resolveCampaignCompletionCredits(
  payload: AnyCampaignCompletionPayload,
  rules: PointRulesSnapshot | null,
): ResolvedCredit[] {
  if (isLegacy(payload)) {
    return payload.credits
      .filter((c) => c.points > 0)
      .map((c) => credit(payload.campaignId, c.userId, c.points, { legacyPayload: true }));
  }
  if (!rules) return [];
  return payload.participants
    .map((p) => {
      const share = Math.min(1, p.eligibleShifts / Math.max(1, p.registeredShifts));
      const points = Math.round(rules.campaignCompletionPoints * share);
      return credit(payload.campaignId, p.userId, points, {
        ruleId: rules.id,
        campaignCompletionPoints: rules.campaignCompletionPoints,
        eligibleShifts: p.eligibleShifts,
        registeredShifts: p.registeredShifts,
      });
    })
    .filter((c) => c.points > 0);
}

export class CampaignCompletionGreenPointStrategy
  implements GreenPointCreditStrategy<AnyCampaignCompletionPayload>
{
  readonly queueJobType = CAMPAIGN_COMPLETION_JOB_TYPE;

  validatePayload(raw: unknown): AnyCampaignCompletionPayload {
    if (raw === null || typeof raw !== "object") {
      throw new Error("Campaign completion payload must be an object");
    }
    const p = raw as Record<string, unknown>;
    if (typeof p.campaignId !== "string" || p.campaignId.length === 0) {
      throw new Error("campaignId is required");
    }
    if (Array.isArray(p.participants)) {
      for (const row of p.participants) {
        const c = (row ?? {}) as Record<string, unknown>;
        if (
          typeof c.userId !== "string" ||
          c.userId.length === 0 ||
          !Number.isInteger(c.eligibleShifts) ||
          (c.eligibleShifts as number) < 1 ||
          !Number.isInteger(c.registeredShifts) ||
          (c.registeredShifts as number) < 0
        ) {
          throw new Error(
            "Each participant needs userId, eligibleShifts (int >= 1) and registeredShifts (int >= 0)",
          );
        }
      }
      return raw as CampaignCompletionGreenPointsPayload;
    }
    if (Array.isArray(p.credits)) {
      for (const row of p.credits) {
        const c = (row ?? {}) as Record<string, unknown>;
        if (typeof c.userId !== "string" || typeof c.points !== "number") {
          throw new Error("Each credit needs userId (string) and points (number)");
        }
      }
      return raw as LegacyCampaignCompletionGreenPointsPayload;
    }
    throw new Error("participants (or legacy credits) must be an array");
  }

  async applyInTransaction(
    tx: Prisma.TransactionClient,
    payload: AnyCampaignCompletionPayload,
  ): Promise<GreenPointApplyResult> {
    const rules = isLegacy(payload) ? null : await loadActivePointRules(tx);
    if (!isLegacy(payload) && !rules) {
      return warnNoPointRules(this.queueJobType, payload.campaignId);
    }
    return applyResolvedCredits(tx, resolveCampaignCompletionCredits(payload, rules));
  }
}
