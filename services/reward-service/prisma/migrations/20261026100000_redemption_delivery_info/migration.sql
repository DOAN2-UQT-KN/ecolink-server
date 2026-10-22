-- Delivery details of a gift order: who receives it, where exactly (map pin + house/floor), and a note.
-- Nullable so older orders stay valid; the redeem API requires the recipient and the pin.
ALTER TABLE "gift_redemptions"
  ADD COLUMN "recipient_name" VARCHAR(100),
  ADD COLUMN "address_detail" VARCHAR(255),
  ADD COLUMN "delivery_latitude" DOUBLE PRECISION,
  ADD COLUMN "delivery_longitude" DOUBLE PRECISION,
  ADD COLUMN "delivery_note" VARCHAR(500);
