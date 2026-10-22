-- Step 2 (spec 014): one green-point ledger with a per-user idempotency key, SP wallet renamed to lots,
-- lot spends per redemption, point expiry days in the point rules. No data is dropped.

-- 1. Idempotency key on the ledger, backfilled with the step-2 key scheme (research R1).
ALTER TABLE "green_point_transactions" ADD COLUMN "idempotency_key" VARCHAR(256);

UPDATE "green_point_transactions" t
SET "idempotency_key" = CASE
    WHEN t."deleted_at" IS NOT NULL THEN 'deleted:' || t."id"
    WHEN t."type" = 'CAMPAIGN_COMPLETION' THEN 'campaign_completion:' || t."resource_id"
    WHEN t."type" = 'REPORT_COMPLETION' THEN 'report_completion:' || t."resource_id"
    WHEN t."type" = 'REPORT_VOTE_MILESTONE' THEN COALESCE(
        'vote_milestone:' || t."resource_id" || ':' || substring(t."resource_type" from '^REPORT_VOTE_MILESTONE_(\d+)$'),
        'legacy:' || t."type" || ':' || t."resource_type" || ':' || t."resource_id")
    WHEN t."type" = 'GIFT_REDEEM' THEN 'gift_redeem:' || t."resource_id"
    WHEN t."type" = 'GIFT_REDEEM_REFUND' THEN 'gift_redeem_refund:' || t."resource_id"
    ELSE 'legacy:' || t."type" || ':' || t."resource_type" || ':' || t."resource_id"
END;

-- The milestone threshold now lives in the key; the row points at the report.
UPDATE "green_point_transactions"
SET "resource_type" = 'REPORT'
WHERE "type" = 'REPORT_VOTE_MILESTONE'
  AND "resource_type" ~ '^REPORT_VOTE_MILESTONE_\d+$';

ALTER TABLE "green_point_transactions" ALTER COLUMN "idempotency_key" SET NOT NULL;
CREATE UNIQUE INDEX "green_point_transactions_user_id_idempotency_key_key"
    ON "green_point_transactions"("user_id", "idempotency_key");
DROP INDEX "green_point_transactions_idempotent_key";

-- 2. SP wallet becomes the green-point lots (ids, remaining and expiry kept as is).
ALTER TABLE "user_sp_wallet" RENAME TO "green_point_lots";
ALTER TABLE "green_point_lots" RENAME CONSTRAINT "user_sp_wallet_pkey" TO "green_point_lots_pkey";
ALTER INDEX "user_sp_wallet_expires_at_idx" RENAME TO "green_point_lots_expires_at_idx";
DROP INDEX "user_sp_wallet_user_id_expires_at_idx";
CREATE INDEX "green_point_lots_user_id_expires_at_active_idx"
    ON "green_point_lots"("user_id", "expires_at") WHERE "remaining" > 0;

ALTER TABLE "green_point_lots" ALTER COLUMN "source_type" DROP NOT NULL;
ALTER TABLE "green_point_lots" ADD COLUMN "transaction_id" UUID;
CREATE UNIQUE INDEX "green_point_lots_transaction_id_key" ON "green_point_lots"("transaction_id");
ALTER TABLE "green_point_lots" ADD CONSTRAINT "green_point_lots_transaction_id_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "green_point_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "green_point_lots" ADD CONSTRAINT "green_point_lots_remaining_check"
    CHECK ("remaining" >= 0 AND "remaining" <= "amount");

-- 3. Which lots each redemption took points from.
CREATE TABLE "green_point_lot_spends" (
    "id" UUID NOT NULL,
    "redemption_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "green_point_lot_spends_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "green_point_lot_spends_amount_check" CHECK ("amount" > 0)
);
CREATE INDEX "green_point_lot_spends_redemption_id_idx" ON "green_point_lot_spends"("redemption_id");
CREATE UNIQUE INDEX "green_point_lot_spends_redemption_id_lot_id_key" ON "green_point_lot_spends"("redemption_id", "lot_id");
ALTER TABLE "green_point_lot_spends" ADD CONSTRAINT "green_point_lot_spends_redemption_id_fkey"
    FOREIGN KEY ("redemption_id") REFERENCES "gift_redemptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "green_point_lot_spends" ADD CONSTRAINT "green_point_lot_spends_lot_id_fkey"
    FOREIGN KEY ("lot_id") REFERENCES "green_point_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Point expiry days move into the point rules (value carried over from the SP rules).
ALTER TABLE "gamification_point_rules" ADD COLUMN "point_expiration_days" INTEGER NOT NULL DEFAULT 90;
UPDATE "gamification_point_rules"
SET "point_expiration_days" = s."expiration_days"
FROM (
    SELECT "expiration_days" FROM "spendable_point_rules"
    WHERE "is_active" ORDER BY "effective_from" DESC LIMIT 1
) s
WHERE s."expiration_days" >= 1;
