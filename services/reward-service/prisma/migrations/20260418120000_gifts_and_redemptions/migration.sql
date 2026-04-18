-- CreateTable
CREATE TABLE "gifts" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "media_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "green_points" INTEGER NOT NULL,
    "stock_remaining" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "gifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_redemptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "gift_id" UUID NOT NULL,
    "green_points_spent" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_redemptions_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "gift_redemptions" ADD CONSTRAINT "gift_redemptions_gift_id_fkey" FOREIGN KEY ("gift_id") REFERENCES "gifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "gifts_deleted_at_idx" ON "gifts"("deleted_at");

-- CreateIndex
CREATE INDEX "gifts_is_active_idx" ON "gifts"("is_active");

-- CreateIndex
CREATE INDEX "gift_redemptions_user_id_idx" ON "gift_redemptions"("user_id");

-- CreateIndex
CREATE INDEX "gift_redemptions_gift_id_idx" ON "gift_redemptions"("gift_id");
