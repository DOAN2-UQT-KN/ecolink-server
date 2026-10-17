-- CreateTable
CREATE TABLE "media_hashes" (
    "id" UUID NOT NULL,
    "media_id" UUID NOT NULL,
    "algorithm" VARCHAR(50) NOT NULL,
    "hash" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_hashes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_hashes_algorithm_hash_idx" ON "media_hashes"("algorithm", "hash");

-- CreateIndex
CREATE UNIQUE INDEX "media_hashes_media_id_algorithm_key" ON "media_hashes"("media_id", "algorithm");

-- AddForeignKey
ALTER TABLE "media_hashes" ADD CONSTRAINT "media_hashes_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE CASCADE ON UPDATE CASCADE;
