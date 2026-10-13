-- Trust / KYC axes on organizations. `kyc_status` (paperwork verdict) and `trust_tier`
-- (Blue Tick privilege) are deliberately separate columns: an organization can have approved
-- paperwork for months without yet earning the tick.
-- Rollback: ALTER TABLE "organizations"
--   DROP COLUMN "address", DROP COLUMN "org_type", DROP COLUMN "kyc_status",
--   DROP COLUMN "trust_tier", DROP COLUMN "tick_suspended", DROP COLUMN "domain_verified",
--   DROP COLUMN "verified_at", DROP COLUMN "verified_by", DROP COLUMN "verification_expires_at",
--   DROP COLUMN "tick_revoked_reason", DROP COLUMN "profile_completeness",
--   DROP COLUMN "successful_campaign_count", DROP COLUMN "violation_count",
--   DROP COLUMN "legal_rep_limit_override", DROP COLUMN "application_id";

-- AlterTable
ALTER TABLE "organizations"
    ADD COLUMN "address" VARCHAR(500),
    ADD COLUMN "org_type" VARCHAR(32),
    ADD COLUMN "kyc_status" VARCHAR(20) NOT NULL DEFAULT 'NOT_SUBMITTED',
    ADD COLUMN "trust_tier" VARCHAR(10) NOT NULL DEFAULT 'NONE',
    ADD COLUMN "tick_suspended" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "domain_verified" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "verified_at" TIMESTAMP(3),
    ADD COLUMN "verified_by" UUID,
    ADD COLUMN "verification_expires_at" TIMESTAMP(3),
    ADD COLUMN "tick_revoked_reason" TEXT,
    ADD COLUMN "profile_completeness" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "successful_campaign_count" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "violation_count" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "legal_rep_limit_override" INTEGER,
    ADD COLUMN "application_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "organizations_application_id_key" ON "organizations"("application_id");

-- CreateIndex
CREATE INDEX "organizations_trust_tier_status_idx" ON "organizations"("trust_tier", "status");

-- CreateIndex
CREATE INDEX "organizations_kyc_status_verification_expires_at_idx" ON "organizations"("kyc_status", "verification_expires_at");

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "organization_applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;
