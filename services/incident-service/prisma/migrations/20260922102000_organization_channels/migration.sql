-- Public contact channels of an approved organization (fanpage / website / Zalo OA).
-- Rollback: DROP TABLE "organization_channels";

-- CreateTable
CREATE TABLE "organization_channels" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "organization_channels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "organization_channels_organization_id_idx" ON "organization_channels"("organization_id");

-- CreateIndex
CREATE INDEX "organization_channels_deleted_at_idx" ON "organization_channels"("deleted_at");

-- AddForeignKey
ALTER TABLE "organization_channels" ADD CONSTRAINT "organization_channels_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
