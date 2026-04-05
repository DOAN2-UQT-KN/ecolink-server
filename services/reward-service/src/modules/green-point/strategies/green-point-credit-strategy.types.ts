import type { Prisma } from "@prisma/client";

export interface GreenPointApplyResult {
  credited: number;
  skipped: number;
}

/**
 * Strategy for a queued green-point job. Resolved by `GreenPointFactory.getStrategy(jobType)`.
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
