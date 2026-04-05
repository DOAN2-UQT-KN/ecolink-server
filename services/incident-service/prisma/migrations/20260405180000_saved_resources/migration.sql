-- CreateTable
CREATE TABLE "saved_resources" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "resource_type" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "saved_resources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "saved_resources_user_id_resource_type_resource_id_key" ON "saved_resources"("user_id", "resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "saved_resources_resource_type_resource_id_idx" ON "saved_resources"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "saved_resources_user_id_idx" ON "saved_resources"("user_id");
