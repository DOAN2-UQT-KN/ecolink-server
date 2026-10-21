-- Spec 015: gift sources and batch stock. Statements 4-6 are re-runnable by hand (FR-081).

-- 1. Enums and tables
CREATE TYPE "GiftSourceType" AS ENUM ('SPONSOR', 'ECOLINK', 'DONATION');
CREATE TYPE "GiftSourceStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "GiftStockMovementType" AS ENUM ('STOCK_IN', 'REDEEM_OUT', 'CANCEL_RETURN', 'ADJUST_OUT', 'EXPIRED');
CREATE TYPE "GiftStockAdjustReason" AS ENUM ('DAMAGED', 'LOST', 'COUNT_SHORTAGE', 'RETURN_TO_SOURCE');

CREATE TABLE "gift_sources" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "type" "GiftSourceType" NOT NULL,
    "contact_name" VARCHAR(255),
    "contact_phone" VARCHAR(32),
    "contact_email" VARCHAR(255),
    "logo_media_id" UUID,
    "show_on_gift" BOOLEAN NOT NULL DEFAULT false,
    "status" "GiftSourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "gift_sources_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "gift_stock_batches" (
    "id" UUID NOT NULL,
    "gift_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "unit_value_vnd" INTEGER NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "reference" VARCHAR(255) NOT NULL,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gift_stock_batches_pkey" PRIMARY KEY ("id"),
    -- 2. Batch checks
    CONSTRAINT "gift_stock_batches_quantity_check" CHECK ("quantity" > 0),
    CONSTRAINT "gift_stock_batches_remaining_check" CHECK ("remaining" >= 0 AND "remaining" <= "quantity"),
    CONSTRAINT "gift_stock_batches_unit_value_check" CHECK ("unit_value_vnd" >= 0),
    CONSTRAINT "gift_stock_batches_expiry_check" CHECK ("expires_at" IS NULL OR "expires_at" > "received_at")
);

CREATE TABLE "gift_stock_movements" (
    "id" UUID NOT NULL,
    "gift_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "type" "GiftStockMovementType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" "GiftStockAdjustReason",
    "note" TEXT,
    "redemption_id" UUID,
    "actor_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gift_stock_movements_pkey" PRIMARY KEY ("id"),
    -- 3. A reason is required for write-offs and only for them
    CONSTRAINT "gift_stock_movements_reason_check" CHECK (("type" = 'ADJUST_OUT') = ("reason" IS NOT NULL))
);

CREATE INDEX "gift_sources_status_type_idx" ON "gift_sources"("status", "type");
CREATE INDEX "gift_sources_name_idx" ON "gift_sources"("name");
CREATE INDEX "gift_stock_batches_source_id_received_at_idx" ON "gift_stock_batches"("source_id", "received_at");
CREATE INDEX "gift_stock_batches_gift_live_idx" ON "gift_stock_batches"("gift_id", "expires_at") WHERE "remaining" > 0;
CREATE INDEX "gift_stock_batches_expiry_live_idx" ON "gift_stock_batches"("expires_at") WHERE "remaining" > 0;
CREATE INDEX "gift_stock_movements_gift_id_created_at_idx" ON "gift_stock_movements"("gift_id", "created_at" DESC);
CREATE INDEX "gift_stock_movements_batch_id_idx" ON "gift_stock_movements"("batch_id");
CREATE UNIQUE INDEX "gift_stock_movements_redemption_id_type_key" ON "gift_stock_movements"("redemption_id", "type");

ALTER TABLE "gift_sources" ADD CONSTRAINT "gift_sources_logo_media_id_fkey" FOREIGN KEY ("logo_media_id") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "gift_stock_batches" ADD CONSTRAINT "gift_stock_batches_gift_id_fkey" FOREIGN KEY ("gift_id") REFERENCES "gifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "gift_stock_batches" ADD CONSTRAINT "gift_stock_batches_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "gift_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "gift_stock_movements" ADD CONSTRAINT "gift_stock_movements_gift_id_fkey" FOREIGN KEY ("gift_id") REFERENCES "gifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "gift_stock_movements" ADD CONSTRAINT "gift_stock_movements_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "gift_stock_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "gift_stock_movements" ADD CONSTRAINT "gift_stock_movements_redemption_id_fkey" FOREIGN KEY ("redemption_id") REFERENCES "gift_redemptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Source holding the stock that existed before batches
INSERT INTO "gift_sources" ("id", "name", "type", "show_on_gift", "status", "note", "updated_at")
VALUES ('00000000-0000-4000-8000-000000000015', 'Tồn kho trước refactor', 'ECOLINK', false, 'ACTIVE',
        'Created by migration 20261023100000_gift_sources_stock', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- 5. One batch per gift with finite stock > 0, soft-deleted gifts included (FR-082)
INSERT INTO "gift_stock_batches" ("id", "gift_id", "source_id", "quantity", "remaining", "unit_value_vnd", "received_at", "reference", "note")
SELECT gen_random_uuid(), g."id", '00000000-0000-4000-8000-000000000015', g."stock_remaining", g."stock_remaining", 0,
       CURRENT_TIMESTAMP, 'MIGRATION', 'Stock before batches'
FROM "gifts" g
WHERE g."stock_remaining" > 0
  AND NOT EXISTS (
    SELECT 1 FROM "gift_stock_batches" b
    WHERE b."gift_id" = g."id" AND b."source_id" = '00000000-0000-4000-8000-000000000015'
  );

-- 6. STOCK_IN for each migration batch that has no movement yet
INSERT INTO "gift_stock_movements" ("id", "gift_id", "batch_id", "type", "quantity")
SELECT gen_random_uuid(), b."gift_id", b."id", 'STOCK_IN', b."quantity"
FROM "gift_stock_batches" b
WHERE b."source_id" = '00000000-0000-4000-8000-000000000015'
  AND NOT EXISTS (SELECT 1 FROM "gift_stock_movements" m WHERE m."batch_id" = b."id");

-- 7. No more "unlimited" stock: NULL becomes 0 (listed beforehand in unlimited-gifts.csv)
UPDATE "gifts" SET "stock_remaining" = 0 WHERE "stock_remaining" IS NULL;
ALTER TABLE "gifts" ALTER COLUMN "stock_remaining" SET DEFAULT 0,
                    ALTER COLUMN "stock_remaining" SET NOT NULL;

-- 8. Batch an order's item came from; NULL for orders before this migration
ALTER TABLE "gift_redemptions" ADD COLUMN "batch_id" UUID;
CREATE INDEX "gift_redemptions_batch_id_idx" ON "gift_redemptions"("batch_id");
ALTER TABLE "gift_redemptions" ADD CONSTRAINT "gift_redemptions_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "gift_stock_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
