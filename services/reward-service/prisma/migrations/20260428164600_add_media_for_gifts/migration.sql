-- CreateTable
CREATE TABLE IF NOT EXISTS "media" (
    "id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "gifts" ALTER COLUMN "media_id" DROP NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "media_type_idx" ON "media"("type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "media_deleted_at_idx" ON "media"("deleted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "gifts_media_id_idx" ON "gifts"("media_id");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'gifts_media_id_fkey'
    ) THEN
        -- Use NOT VALID to avoid failing deploy on historical rows that reference media records not yet backfilled.
        ALTER TABLE "gifts"
        ADD CONSTRAINT "gifts_media_id_fkey"
        FOREIGN KEY ("media_id")
        REFERENCES "media"("id")
        ON DELETE RESTRICT
        ON UPDATE CASCADE
        NOT VALID;
    END IF;
END $$;
