-- CreateTable
CREATE TABLE "sos" (
    "id" SERIAL NOT NULL,
    "campaign_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "address" VARCHAR(500) NOT NULL,
    "detail_address" VARCHAR(255),
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "status" INTEGER NOT NULL DEFAULT 12,
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "sos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sos_campaign_id_idx" ON "sos"("campaign_id");

-- CreateIndex
CREATE INDEX "sos_status_idx" ON "sos"("status");

-- CreateIndex
CREATE INDEX "sos_deleted_at_idx" ON "sos"("deleted_at");

-- AddForeignKey
ALTER TABLE "sos" ADD CONSTRAINT "sos_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
