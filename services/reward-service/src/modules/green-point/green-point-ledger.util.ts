import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { loadActivePointRules } from "../gamification/gamification-config.service";
import type {
  GreenPointApplyResult,
  ResolvedCredit,
} from "./strategies/green-point-credit-strategy.types";

export type LedgerApplyOutcome = "credited" | "skipped";

const DEFAULT_POINT_EXPIRATION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

type LedgerWriter = Pick<Prisma.TransactionClient, "greenPointTransaction">;

export type LedgerRow = {
  userId: string;
  points: number;
  type: string;
  resourceId: string;
  resourceType: string;
  idempotencyKey: string;
  metadata?: Prisma.InputJsonValue;
};

/**
 * Inserts the ledger row unless (user_id, idempotency_key) already exists; returns its id, or null
 * when it was already written. ON CONFLICT DO NOTHING instead of catching P2002: in Postgres a failed
 * statement aborts the whole transaction, so later writes in the same job would fail.
 */
export async function insertLedgerOnce(db: LedgerWriter, row: LedgerRow): Promise<string | null> {
  const id = randomUUID();
  const { count } = await db.greenPointTransaction.createMany({
    data: [{ id, ...row }],
    skipDuplicates: true,
  });
  return count === 1 ? id : null;
}

/** Days until a new lot expires, from the point rules in force (90 when there is no rule). */
export async function loadPointExpirationDays(
  tx: Pick<Prisma.TransactionClient, "gamificationPointRules">,
): Promise<number> {
  return (await loadActivePointRules(tx))?.pointExpirationDays ?? DEFAULT_POINT_EXPIRATION_DAYS;
}

export function lotExpiresAt(now: Date, expirationDays: number): Date {
  return new Date(now.getTime() + expirationDays * DAY_MS);
}

/** One ledger row plus one lot of the same amount; duplicates and amounts <= 0 are skipped. */
export async function creditPoints(
  tx: Prisma.TransactionClient,
  row: LedgerRow,
  expirationDays: number,
  now: Date = new Date(),
): Promise<LedgerApplyOutcome> {
  if (row.points <= 0) return "skipped";
  const transactionId = await insertLedgerOnce(tx, row);
  if (!transactionId) return "skipped";
  await tx.greenPointLot.create({
    data: {
      userId: row.userId,
      transactionId,
      amount: row.points,
      remaining: row.points,
      createdAt: now,
      expiresAt: lotExpiresAt(now, expirationDays),
    },
  });
  return "credited";
}

/** Applies each resolved credit; duplicates and zero amounts count as skipped. */
export async function applyResolvedCredits(
  tx: Prisma.TransactionClient,
  credits: ResolvedCredit[],
): Promise<GreenPointApplyResult> {
  let credited = 0;
  let skipped = 0;
  if (credits.length === 0) return { credited, skipped };
  const expirationDays = await loadPointExpirationDays(tx);
  for (const c of credits) {
    const outcome = await creditPoints(
      tx,
      {
        userId: c.userId,
        points: c.points,
        type: c.transactionType,
        resourceId: c.resourceId,
        resourceType: c.resourceType,
        idempotencyKey: c.idempotencyKey,
        metadata: c.metadata,
      },
      expirationDays,
    );
    if (outcome === "credited") credited++;
    else skipped++;
  }
  return { credited, skipped };
}

/** No active point rules: nothing to credit (spec 013 FR-033). Not an error, so no retry. */
export function warnNoPointRules(jobType: string, resourceId: string): GreenPointApplyResult {
  console.warn(`[green-point] no active point rules; ${jobType} for ${resourceId} not credited`);
  return { credited: 0, skipped: 0 };
}
