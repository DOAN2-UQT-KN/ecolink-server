-- Spec 016: cancelling an order records why, and whether the item came back to stock.
ALTER TABLE "gift_redemptions"
  ADD COLUMN "cancel_reason" VARCHAR(500),
  ADD COLUMN "restocked" BOOLEAN;
