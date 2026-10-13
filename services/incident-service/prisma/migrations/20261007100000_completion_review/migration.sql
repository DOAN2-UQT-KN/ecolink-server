-- Spec 5.1 / 5.2: completion submission built from the shifts' results, admin rejection that
-- reopens shifts, and the rejection count (at 3 only approve or cancel remain).
ALTER TABLE "campaigns" ADD COLUMN "completion_submitted_at" TIMESTAMP(3);
ALTER TABLE "campaigns" ADD COLUMN "completion_rejection_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "campaign_shift_results" ADD COLUMN "reopened_at" TIMESTAMP(3);
ALTER TABLE "campaign_shift_results" ADD COLUMN "reopen_reason" TEXT;
ALTER TABLE "campaign_shift_results" ADD COLUMN "reopened_by" UUID;

CREATE TABLE "campaign_completion_reports" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "reason" TEXT,
    "before_urls" TEXT[],
    "after_urls" TEXT[],
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_completion_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "campaign_completion_reports_campaign_id_report_id_key" ON "campaign_completion_reports"("campaign_id", "report_id");
CREATE INDEX "campaign_completion_reports_report_id_idx" ON "campaign_completion_reports"("report_id");

ALTER TABLE "campaign_completion_reports"
  ADD CONSTRAINT "campaign_completion_reports_campaign_id_fkey"
  FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
