-- Generic ledger; drop campaign-specific table if present (from earlier migration).
DROP TABLE IF EXISTS "campaign_completion_green_credits";

CREATE TABLE "green_point_transactions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "resource_id" UUID NOT NULL,
    "resource_type" VARCHAR(64) NOT NULL,
    "points" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "green_point_transactions_pkey" PRIMARY KEY ("id")
);

-- One active earning per (user, rule, resource); allows soft-delete + re-earn later if needed.
CREATE UNIQUE INDEX "green_point_transactions_idempotent_key"
ON "green_point_transactions" ("user_id", "type", "resource_id", "resource_type")
WHERE "deleted_at" IS NULL;

CREATE INDEX "green_point_transactions_user_id_idx" ON "green_point_transactions"("user_id");
CREATE INDEX "green_point_transactions_resource_idx" ON "green_point_transactions"("resource_type", "resource_id");
CREATE INDEX "green_point_transactions_type_idx" ON "green_point_transactions"("type");
