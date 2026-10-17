-- Report verification (specs/006, plan P03): server-issued camera captures; LIVE/GALLERY source of report images.

-- CreateTable
CREATE TABLE "media_captures" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),

    CONSTRAINT "media_captures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_captures_user_id_issued_at_idx" ON "media_captures"("user_id", "issued_at");

-- AddForeignKey
ALTER TABLE "report_media_files" ADD CONSTRAINT "report_media_files_capture_id_fkey" FOREIGN KEY ("capture_id") REFERENCES "media_captures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

