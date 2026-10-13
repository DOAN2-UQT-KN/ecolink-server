-- Applications to found an organization. A first-class entity, not an organization in a draft
-- state: `organizations` only ever holds approved rows.
-- Rollback: DROP TABLE "organization_applications";

-- CreateTable
CREATE TABLE "organization_applications" (
    "id" UUID NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "org_type" VARCHAR(32) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'SUBMITTED',
    "lane" VARCHAR(1),
    "documents_waived" BOOLEAN NOT NULL DEFAULT false,
    "documents_waived_reason" TEXT,
    "profile" JSONB NOT NULL,
    "channels" JSONB NOT NULL DEFAULT '[]',
    "contact_email" VARCHAR(320) NOT NULL,
    "legal_rep_name" VARCHAR(200),
    "legal_rep_phone" VARCHAR(32),
    "legal_rep_email" VARCHAR(320),
    "legal_rep_position" VARCHAR(200),
    "legal_rep_id_type" VARCHAR(20),
    "legal_rep_id_hash" VARCHAR(64),
    "legal_rep_id_last4" VARCHAR(4),
    "submitted_by_user_id" UUID,
    "email_verified_at" TIMESTAMP(3),
    "consented_at" TIMESTAMP(3),
    "reviewer_id" UUID,
    "claimed_at" TIMESTAMP(3),
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT,
    "reject_reason" TEXT,
    "organization_id" UUID,
    "account_provisioned_at" TIMESTAMP(3),
    "purged_at" TIMESTAMP(3),
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "organization_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_applications_code_key" ON "organization_applications"("code");

-- CreateIndex
CREATE INDEX "organization_applications_status_idx" ON "organization_applications"("status");

-- CreateIndex
CREATE INDEX "organization_applications_contact_email_idx" ON "organization_applications"("contact_email");

-- CreateIndex
CREATE INDEX "organization_applications_legal_rep_id_hash_idx" ON "organization_applications"("legal_rep_id_hash");

-- CreateIndex
CREATE INDEX "organization_applications_reviewer_id_idx" ON "organization_applications"("reviewer_id");

-- CreateIndex
CREATE INDEX "organization_applications_deleted_at_idx" ON "organization_applications"("deleted_at");
