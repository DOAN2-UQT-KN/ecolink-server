-- CreateTable
CREATE TABLE "campaign_task_results" (
    "id" UUID NOT NULL,
    "campaign_task_id" UUID NOT NULL,
    "description" TEXT,
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_task_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_task_result_files" (
    "id" UUID NOT NULL,
    "campaign_task_result_id" UUID NOT NULL,
    "media_id" UUID NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_task_result_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "campaign_task_results_campaign_task_id_key" ON "campaign_task_results"("campaign_task_id");

-- CreateIndex
CREATE INDEX "campaign_task_result_files_campaign_task_result_id_idx" ON "campaign_task_result_files"("campaign_task_result_id");

-- CreateIndex
CREATE INDEX "campaign_task_result_files_media_id_idx" ON "campaign_task_result_files"("media_id");

-- AddForeignKey
ALTER TABLE "campaign_task_results" ADD CONSTRAINT "campaign_task_results_campaign_task_id_fkey" FOREIGN KEY ("campaign_task_id") REFERENCES "campaign_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_task_result_files" ADD CONSTRAINT "campaign_task_result_files_campaign_task_result_id_fkey" FOREIGN KEY ("campaign_task_result_id") REFERENCES "campaign_task_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_task_result_files" ADD CONSTRAINT "campaign_task_result_files_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
