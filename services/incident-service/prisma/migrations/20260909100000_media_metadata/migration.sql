-- AlterTable
ALTER TABLE "media" ADD COLUMN     "mime_type" VARCHAR(100),
ADD COLUMN     "file_size" BIGINT,
ADD COLUMN     "width" INTEGER,
ADD COLUMN     "height" INTEGER,
ADD COLUMN     "captured_at" TIMESTAMP(3),
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION,
ADD COLUMN     "camera_make" VARCHAR(100),
ADD COLUMN     "camera_model" VARCHAR(100),
ADD COLUMN     "metadata" JSONB;

-- AddForeignKey
ALTER TABLE "report_media_files" ADD CONSTRAINT "report_media_files_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_result_files" ADD CONSTRAINT "campaign_result_files_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
