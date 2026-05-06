-- Metric metadata for badge rule builder (tables / columns only; no agg/op storage).

CREATE TABLE "metric_tables" (
    "id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "label" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metric_tables_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "metric_tables_key_key" ON "metric_tables"("key");

CREATE TABLE "metric_columns" (
    "id" UUID NOT NULL,
    "table_id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "label" VARCHAR(255) NOT NULL,
    "value_type" VARCHAR(32) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metric_columns_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "metric_columns_table_id_fkey"
      FOREIGN KEY ("table_id") REFERENCES "metric_tables"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "metric_columns_table_id_key_key" ON "metric_columns"("table_id", "key");

CREATE INDEX "metric_columns_table_id_idx" ON "metric_columns"("table_id");
