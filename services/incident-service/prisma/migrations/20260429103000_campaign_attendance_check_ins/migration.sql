-- CreateTable
CREATE TABLE "campaign_attendance_check_ins" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "checked_in_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_attendance_check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "campaign_attendance_check_ins_campaign_id_user_id_key" ON "campaign_attendance_check_ins"("campaign_id", "user_id");

-- CreateIndex
CREATE INDEX "campaign_attendance_check_ins_campaign_id_idx" ON "campaign_attendance_check_ins"("campaign_id");

-- CreateIndex
CREATE INDEX "campaign_attendance_check_ins_user_id_idx" ON "campaign_attendance_check_ins"("user_id");

-- AddForeignKey
ALTER TABLE "campaign_attendance_check_ins" ADD CONSTRAINT "campaign_attendance_check_ins_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
