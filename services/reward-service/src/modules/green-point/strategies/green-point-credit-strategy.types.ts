import type { Prisma } from "@prisma/client";

export interface GreenPointApplyResult {
  credited: number;
  skipped: number;
}

/**
 * One credit a strategy computed from its payload and the active point rules. `metadata` keeps the
 * rule id and the inputs so the amount can be re-derived (spec 013 FR-032).
 */
export interface ResolvedCredit {
  userId: string;
  points: number;
  transactionType: string;
  resourceId: string;
  resourceType: string;
  metadata: Prisma.InputJsonValue;
}

/**
 * Strategy for a queued green-point job. Strategies keep a pure `resolve…Credits(payload, rules)`
 * and their {@link GreenPointCreditStrategy.applyInTransaction} reads the rules with
 * `loadActivePointRules(tx)`, so the rate used is the one in force at credit time. Resolved by `GreenPointFactory.getStrategy(jobType)`.
 * {@link applyInTransaction} runs inside a single Serializable Prisma transaction.
 */
export interface GreenPointCreditStrategy<TPayload = unknown> {
  /** Value of `jobType` on the SQS envelope; must be unique across strategies. */
  readonly queueJobType: string;

  /** Narrow `unknown` → TPayload; throw if invalid. */
  validatePayload(raw: unknown): TPayload;

  applyInTransaction(
    tx: Prisma.TransactionClient,
    payload: TPayload,
  ): Promise<GreenPointApplyResult>;
}
