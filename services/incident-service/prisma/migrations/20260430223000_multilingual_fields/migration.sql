-- Add bilingual columns while keeping legacy columns for backward compatibility.
ALTER TABLE "reports"
  ADD COLUMN "title_vi" VARCHAR(200),
  ADD COLUMN "title_en" VARCHAR(200),
  ADD COLUMN "description_vi" TEXT,
  ADD COLUMN "description_en" TEXT;

ALTER TABLE "campaigns"
  ADD COLUMN "title_vi" VARCHAR(200),
  ADD COLUMN "title_en" VARCHAR(200),
  ADD COLUMN "description_vi" TEXT,
  ADD COLUMN "description_en" TEXT;

ALTER TABLE "campaign_tasks"
  ADD COLUMN "title_vi" VARCHAR(200),
  ADD COLUMN "title_en" VARCHAR(200),
  ADD COLUMN "description_vi" TEXT,
  ADD COLUMN "description_en" TEXT;

ALTER TABLE "campaign_task_results"
  ADD COLUMN "description_vi" TEXT,
  ADD COLUMN "description_en" TEXT;

ALTER TABLE "campaign_submissions"
  ADD COLUMN "title_vi" VARCHAR(200),
  ADD COLUMN "title_en" VARCHAR(200),
  ADD COLUMN "description_vi" TEXT,
  ADD COLUMN "description_en" TEXT;

ALTER TABLE "campaign_results"
  ADD COLUMN "title_vi" VARCHAR(200),
  ADD COLUMN "title_en" VARCHAR(200),
  ADD COLUMN "description_vi" TEXT,
  ADD COLUMN "description_en" TEXT;

ALTER TABLE "report_issues"
  ADD COLUMN "description_vi" TEXT,
  ADD COLUMN "description_en" TEXT;

ALTER TABLE "organizations"
  ADD COLUMN "description_vi" TEXT,
  ADD COLUMN "description_en" TEXT;

ALTER TABLE "sos"
  ADD COLUMN "content_vi" TEXT,
  ADD COLUMN "content_en" TEXT;

-- Data backfill: existing text is treated as Vietnamese.
UPDATE "reports"
SET
  "title_vi" = COALESCE("title_vi", "title"),
  "description_vi" = COALESCE("description_vi", "description");

UPDATE "campaigns"
SET
  "title_vi" = COALESCE("title_vi", "title"),
  "description_vi" = COALESCE("description_vi", "description");

UPDATE "campaign_tasks"
SET
  "title_vi" = COALESCE("title_vi", "title"),
  "description_vi" = COALESCE("description_vi", "description");

UPDATE "campaign_task_results"
SET
  "description_vi" = COALESCE("description_vi", "description");

UPDATE "campaign_submissions"
SET
  "title_vi" = COALESCE("title_vi", "title"),
  "description_vi" = COALESCE("description_vi", "description");

UPDATE "campaign_results"
SET
  "title_vi" = COALESCE("title_vi", "title"),
  "description_vi" = COALESCE("description_vi", "description");

UPDATE "report_issues"
SET
  "description_vi" = COALESCE("description_vi", "description");

UPDATE "organizations"
SET
  "description_vi" = COALESCE("description_vi", "description");

UPDATE "sos"
SET
  "content_vi" = COALESCE("content_vi", "content");
