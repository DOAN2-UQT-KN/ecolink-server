import "dotenv/config";
import { writeFileSync } from "fs";
import prisma from "../config/prisma.client";
import { expireDueLots } from "../modules/green-point/green-point-expiry.job";
import { insertLedgerOnce } from "../modules/green-point/green-point-ledger.util";
import {
  GreenPointResourceType,
  GreenPointTransactionType,
  IdempotencyKey,
} from "../modules/green-point/green-point-transaction.constants";

/**
 * Spec 014 migration step, safe to re-run: expire overdue lots, then give every user whose ledger
 * does not add up to their lots one MIGRATION_ADJUST row (lots are the truth), and write the list to CSV.
 * Run after `prisma migrate deploy`: `npm run reconcile:green-points` (dev: `npm run dev:reconcile:green-points`).
 */
async function main(): Promise<number> {
  const { expired, failed } = await expireDueLots();
  console.log(`[reconcile] expired ${expired} lot(s), ${failed} failed`);
  if (failed > 0) {
    console.error("[reconcile] some lots could not be expired; re-run before reconciling");
    return 1;
  }

  const rows = await prisma.$queryRaw<Array<{ user_id: string; ledger_sum: bigint; lot_sum: bigint }>>`
    SELECT COALESCE(l.user_id, t.user_id) AS user_id,
           COALESCE(t.s, 0) AS ledger_sum,
           COALESCE(l.s, 0) AS lot_sum
    FROM (SELECT user_id, SUM(remaining) AS s FROM green_point_lots GROUP BY user_id) l
    FULL JOIN (
      SELECT user_id, SUM(points) AS s FROM green_point_transactions
      WHERE deleted_at IS NULL GROUP BY user_id
    ) t ON t.user_id = l.user_id
    WHERE COALESCE(l.s, 0) <> COALESCE(t.s, 0)
  `;

  const lines = ["user_id,ledger_sum,lot_sum,diff"];
  let adjusted = 0;
  for (const r of rows) {
    const ledgerSum = Number(r.ledger_sum);
    const lotSum = Number(r.lot_sum);
    const diff = lotSum - ledgerSum;
    lines.push(`${r.user_id},${ledgerSum},${lotSum},${diff}`);
    const id = await insertLedgerOnce(prisma, {
      userId: r.user_id,
      points: diff,
      type: GreenPointTransactionType.MIGRATION_ADJUST,
      resourceId: r.user_id,
      resourceType: GreenPointResourceType.USER,
      idempotencyKey: IdempotencyKey.migrationAdjust(r.user_id),
      metadata: { ledgerSumBefore: ledgerSum, lotSum, reason: "spec 014 SP → green point lots" },
    });
    if (id) adjusted++;
    else console.warn(`[reconcile] ${r.user_id} already adjusted, diff still ${diff}`);
  }

  const file = `reconcile-green-points-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  writeFileSync(file, `${lines.join("\n")}\n`);
  console.log(`[reconcile] ${rows.length} user(s) off, ${adjusted} adjusted; list written to ${file}`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error("[reconcile] failed", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
