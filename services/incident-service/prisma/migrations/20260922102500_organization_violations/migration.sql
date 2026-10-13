-- Recorded misconduct feeding the Blue Tick revocation rules. Created ahead of the
-- post-moderation phase: nothing writes to this table yet.
-- Rollback: DROP TABLE "organization_violations";

-- CreateTable
CREATE TABLE "organization_violations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "campaign_id" UUID,
    "severity" VARCHAR(10) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "organization_violations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "organization_violations_organization_id_idx" ON "organization_violations"("organization_id");

-- CreateIndex
CREATE INDEX "organization_violations_deleted_at_idx" ON "organization_violations"("deleted_at");

-- AddForeignKey
ALTER TABLE "organization_violations" ADD CONSTRAINT "organization_violations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
