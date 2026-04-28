-- 1. Create media table (safe)
CREATE TABLE IF NOT EXISTS "media" (
    "id" UUID PRIMARY KEY,
    "url" TEXT NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3)
);

-- 2. Ensure column media_id exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'gifts'
        AND column_name = 'media_id'
    ) THEN
        ALTER TABLE "gifts"
        ADD COLUMN "media_id" UUID;
    END IF;
END $$;

-- 3. Drop NOT NULL safely
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'gifts'
        AND column_name = 'media_id'
        AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE "gifts"
        ALTER COLUMN "media_id" DROP NOT NULL;
    END IF;
END $$;

-- 4. Indexes (safe)
CREATE INDEX IF NOT EXISTS "media_type_idx" ON "media"("type");
CREATE INDEX IF NOT EXISTS "media_deleted_at_idx" ON "media"("deleted_at");
CREATE INDEX IF NOT EXISTS "gifts_media_id_idx" ON "gifts"("media_id");

-- 5. Foreign key (safe)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'gifts_media_id_fkey'
    ) THEN
        ALTER TABLE "gifts"
        ADD CONSTRAINT "gifts_media_id_fkey"
        FOREIGN KEY ("media_id")
        REFERENCES "media"("id")
        ON DELETE RESTRICT
        ON UPDATE CASCADE
        NOT VALID;
    END IF;
END $$;
