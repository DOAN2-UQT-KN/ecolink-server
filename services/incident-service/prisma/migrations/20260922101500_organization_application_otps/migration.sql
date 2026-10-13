-- One-time email codes and submission tokens for the anonymous application form.
-- They cannot live in identity-service's `auth_tokens` because that table is keyed by a user
-- and an applicant has no account yet. Only hashes are stored.
-- Rollback: DROP TABLE "organization_application_otps";

-- CreateTable
CREATE TABLE "organization_application_otps" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "purpose" VARCHAR(16) NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_application_otps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "organization_application_otps_email_purpose_idx" ON "organization_application_otps"("email", "purpose");

-- CreateIndex
CREATE INDEX "organization_application_otps_code_hash_idx" ON "organization_application_otps"("code_hash");

-- CreateIndex
CREATE INDEX "organization_application_otps_expires_at_idx" ON "organization_application_otps"("expires_at");
