-- Default status: in review (9) for new reports, campaigns, and campaign submissions.
ALTER TABLE "reports" ALTER COLUMN "status" SET DEFAULT 9;
ALTER TABLE "campaigns" ALTER COLUMN "status" SET DEFAULT 9;
ALTER TABLE "campaign_submissions" ALTER COLUMN "status" SET DEFAULT 9;
