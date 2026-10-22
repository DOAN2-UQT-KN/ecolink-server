-- Spec 017: order code, carrier tracking and an append-only order history.

-- CreateEnum
CREATE TYPE "GiftRedemptionEventType" AS ENUM ('CREATED', 'SHIPPED', 'TRACKING_UPDATED', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GiftRedemptionActorRole" AS ENUM ('USER', 'ADMIN');

-- AlterTable: code stays nullable until every existing order has one.
ALTER TABLE "gift_redemptions" ADD COLUMN "code" VARCHAR(11),
ADD COLUMN "carrier" VARCHAR(100),
ADD COLUMN "tracking_code" VARCHAR(100),
ADD COLUMN "shipped_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "gift_redemption_events" (
    "id" UUID NOT NULL,
    "redemption_id" UUID NOT NULL,
    "type" "GiftRedemptionEventType" NOT NULL,
    "from_status" "GiftRedemptionStatus",
    "to_status" "GiftRedemptionStatus",
    "actor_role" "GiftRedemptionActorRole" NOT NULL,
    "actor_id" UUID,
    "data" JSONB,
    "reconstructed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_redemption_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gift_redemption_events_redemption_id_created_at_idx" ON "gift_redemption_events"("redemption_id", "created_at");

-- AddForeignKey
ALTER TABLE "gift_redemption_events" ADD CONSTRAINT "gift_redemption_events_redemption_id_fkey" FOREIGN KEY ("redemption_id") REFERENCES "gift_redemptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill order codes: same alphabet as order-code.util.ts (no 0 O 1 I L), retried on collision.
DO $$
DECLARE
  alphabet CONSTANT TEXT := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  r RECORD;
  candidate TEXT;
BEGIN
  FOR r IN SELECT id FROM gift_redemptions WHERE code IS NULL LOOP
    LOOP
      candidate := 'EL-';
      FOR i IN 1..8 LOOP
        candidate := candidate || substr(alphabet, 1 + floor(random() * 31)::int, 1);
      END LOOP;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM gift_redemptions WHERE code = candidate);
    END LOOP;
    UPDATE gift_redemptions SET code = candidate WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE "gift_redemptions" ALTER COLUMN "code" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "gift_redemptions_code_key" ON "gift_redemptions"("code");

-- Rebuild history for existing orders from the timestamps we have (spec 017 FR-033).
INSERT INTO gift_redemption_events (id, redemption_id, type, from_status, to_status, actor_role, actor_id, data, reconstructed, created_at)
SELECT gen_random_uuid(), id, 'CREATED', NULL, 'PROCESSING', 'USER', user_id, NULL, true, created_at
FROM gift_redemptions;

INSERT INTO gift_redemption_events (id, redemption_id, type, from_status, to_status, actor_role, actor_id, data, reconstructed, created_at)
SELECT gen_random_uuid(), id, 'SHIPPED', 'PROCESSING', 'SHIPPED', 'ADMIN', NULL, NULL, true, status_updated_at
FROM gift_redemptions WHERE status = 'SHIPPED';

-- Delivered orders: the ship time is unknown, so only the delivery is rebuilt.
INSERT INTO gift_redemption_events (id, redemption_id, type, from_status, to_status, actor_role, actor_id, data, reconstructed, created_at)
SELECT gen_random_uuid(), id, 'DELIVERED', NULL, 'DELIVERED', 'ADMIN', NULL, NULL, true, status_updated_at
FROM gift_redemptions WHERE status = 'DELIVERED';

INSERT INTO gift_redemption_events (id, redemption_id, type, from_status, to_status, actor_role, actor_id, data, reconstructed, created_at)
SELECT gen_random_uuid(), id, 'CANCELLED', NULL, 'CANCELLED', 'ADMIN', NULL,
       jsonb_build_object('cancelReason', cancel_reason, 'restocked', restocked), true,
       coalesce(cancelled_at, status_updated_at)
FROM gift_redemptions WHERE status = 'CANCELLED';
