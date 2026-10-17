-- Duplicate verification result written back from ai-service after REPORT_SUBMITTED.
ALTER TABLE "reports" ADD COLUMN "duplicate_verification" JSONB;
