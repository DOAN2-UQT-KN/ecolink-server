-- Shift results and status (spec 4.2). A shift's status is derived from its times, `ended_at`
-- (ended early) and whether it has a result; no status column.
ALTER TABLE "campaign_shifts" ADD COLUMN "ended_at" TIMESTAMP(3);
ALTER TABLE "campaign_shifts" ADD COLUMN "result_reminded_at" TIMESTAMP(3);

CREATE TABLE "campaign_shift_results" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "waste_bags" INTEGER,
    "waste_kg" DOUBLE PRECISION,
    "submitted_by" UUID NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_shift_results_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "campaign_shift_results_shift_id_key" ON "campaign_shift_results"("shift_id");
CREATE INDEX "campaign_shift_results_campaign_id_idx" ON "campaign_shift_results"("campaign_id");

ALTER TABLE "campaign_shift_results"
  ADD CONSTRAINT "campaign_shift_results_campaign_id_fkey"
  FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_shift_results"
  ADD CONSTRAINT "campaign_shift_results_shift_id_fkey"
  FOREIGN KEY ("shift_id") REFERENCES "campaign_shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "campaign_shift_result_reports" (
    "id" UUID NOT NULL,
    "result_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "before_urls" TEXT[],
    "after_urls" TEXT[],

    CONSTRAINT "campaign_shift_result_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "campaign_shift_result_reports_result_id_report_id_key"
  ON "campaign_shift_result_reports"("result_id", "report_id");
CREATE INDEX "campaign_shift_result_reports_report_id_idx" ON "campaign_shift_result_reports"("report_id");

ALTER TABLE "campaign_shift_result_reports"
  ADD CONSTRAINT "campaign_shift_result_reports_result_id_fkey"
  FOREIGN KEY ("result_id") REFERENCES "campaign_shift_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "campaign_shift_media" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "included_in_result" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "campaign_shift_media_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "campaign_shift_media_shift_id_created_at_idx" ON "campaign_shift_media"("shift_id", "created_at");
CREATE INDEX "campaign_shift_media_campaign_id_idx" ON "campaign_shift_media"("campaign_id");

ALTER TABLE "campaign_shift_media"
  ADD CONSTRAINT "campaign_shift_media_campaign_id_fkey"
  FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_shift_media"
  ADD CONSTRAINT "campaign_shift_media_shift_id_fkey"
  FOREIGN KEY ("shift_id") REFERENCES "campaign_shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
