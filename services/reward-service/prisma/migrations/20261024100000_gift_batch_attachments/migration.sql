-- Proof files for a stock batch (contract, sponsor letter, invoice, receipt).
ALTER TABLE "gift_stock_batches" ADD COLUMN "attachment_urls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
