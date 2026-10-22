-- Spec 018: an order carries 1..10 items of one gift, possibly taken from several batches.

ALTER TABLE "gift_redemptions" ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "gift_redemptions" ADD COLUMN "unit_points" INTEGER;
-- Every existing order holds one item, so its unit price is what it cost.
UPDATE "gift_redemptions" SET "unit_points" = "green_points_spent";
ALTER TABLE "gift_redemptions" ALTER COLUMN "unit_points" SET NOT NULL;

ALTER TABLE "gift_redemptions" ADD CONSTRAINT "gift_redemptions_quantity_check" CHECK ("quantity" >= 1);
ALTER TABLE "gift_redemptions" ADD CONSTRAINT "gift_redemptions_unit_points_check" CHECK ("unit_points" >= 0);
ALTER TABLE "gift_redemptions" ADD CONSTRAINT "gift_redemptions_points_total_check"
  CHECK ("green_points_spent" = "unit_points" * "quantity");

-- One movement of each type per order and batch; the old key allowed only one batch per order.
DROP INDEX "gift_stock_movements_redemption_id_type_key";
CREATE UNIQUE INDEX "gift_stock_movements_redemption_id_batch_id_type_key"
  ON "gift_stock_movements"("redemption_id", "batch_id", "type");
