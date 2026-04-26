-- CreateTable
CREATE TABLE "reward_background_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_type" VARCHAR(100) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" INTEGER NOT NULL DEFAULT 12,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reward_background_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reward_background_jobs_job_type_status_idx" ON "reward_background_jobs"("job_type", "status");

-- CreateIndex
CREATE INDEX "reward_background_jobs_status_idx" ON "reward_background_jobs"("status");
