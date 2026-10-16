-- Report verification (specs/006, plan P08): Goong lookups cached per geohash cell and rule version.

-- CreateTable
CREATE TABLE "geo_context_cache" (
    "cell_id" VARCHAR(12) NOT NULL,
    "rule_key" VARCHAR(80) NOT NULL,
    "places" JSONB NOT NULL,
    "address" JSONB,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "geo_context_cache_pkey" PRIMARY KEY ("cell_id","rule_key")
);

-- CreateIndex
CREATE INDEX "geo_context_cache_expires_at_idx" ON "geo_context_cache"("expires_at");

