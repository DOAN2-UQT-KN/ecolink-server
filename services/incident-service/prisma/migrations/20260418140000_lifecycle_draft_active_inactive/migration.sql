-- Report / campaign / organization lifecycle: defaults DRAFT (4); backfill legacy "in review" (9) → DRAFT where still pre-approval.
ALTER TABLE "reports" ALTER COLUMN "status" SET DEFAULT 4;
ALTER TABLE "campaigns" ALTER COLUMN "status" SET DEFAULT 4;
ALTER TABLE "organizations" ALTER COLUMN "status" SET DEFAULT 4;

UPDATE "organizations" SET "status" = 4 WHERE "status" = 9;
UPDATE "campaigns" SET "status" = 4 WHERE "status" = 9;
UPDATE "reports" SET "status" = 4 WHERE "status" = 9 AND "campaign_id" IS NULL;

-- Legacy admin-verified reports used ACTIVE (1); new model uses PENDING (12) for "admin approved, not yet in a campaign".
UPDATE "reports" SET "status" = 12 WHERE "status" = 1 AND "is_verify" = true AND "campaign_id" IS NULL;

-- Legacy org reject used REJECTED (18) → INACTIVE (2).
UPDATE "organizations" SET "status" = 2 WHERE "status" = 18;

-- Legacy org approve used APPROVED (14) → ACTIVE (1).
UPDATE "organizations" SET "status" = 1 WHERE "status" = 14;
