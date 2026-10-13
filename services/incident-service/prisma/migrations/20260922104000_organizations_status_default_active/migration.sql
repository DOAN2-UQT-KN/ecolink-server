-- `organizations` now only ever receives rows the admin already approved, so PENDING (12) is
-- no longer a meaningful default. New rows start ACTIVE (1).
-- Rollback: ALTER TABLE "organizations" ALTER COLUMN "status" SET DEFAULT 12;

-- AlterTable
ALTER TABLE "organizations" ALTER COLUMN "status" SET DEFAULT 1;
