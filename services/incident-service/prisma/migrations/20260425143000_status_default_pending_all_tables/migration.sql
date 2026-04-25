-- Align DB defaults with GlobalStatus._STATUS_PENDING (12) for lifecycle status columns.
ALTER TABLE "campaigns" ALTER COLUMN "status" SET DEFAULT 12;
ALTER TABLE "campaign_tasks" ALTER COLUMN "status" SET DEFAULT 12;
ALTER TABLE "campaign_submissions" ALTER COLUMN "status" SET DEFAULT 12;
ALTER TABLE "organizations" ALTER COLUMN "status" SET DEFAULT 12;
ALTER TABLE "reports" ALTER COLUMN "status" SET DEFAULT 12;