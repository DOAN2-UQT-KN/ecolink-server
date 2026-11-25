-- One row per (risk site, user): what that user said when they went to check the place the
-- dumpsite-risk model flagged. A user can change their mind, so the row is updated, not duplicated.
CREATE TABLE "risk_site_votes" (
    "id"         UUID             NOT NULL DEFAULT gen_random_uuid(),
    "site_key"   VARCHAR(40)      NOT NULL,
    "address"    VARCHAR(255)     NOT NULL,
    "latitude"   DOUBLE PRECISION NOT NULL,
    "longitude"  DOUBLE PRECISION NOT NULL,
    "user_id"    UUID             NOT NULL,
    -- yes = there is trash, no = there is none
    "verdict"    VARCHAR(3)       NOT NULL,
    "created_at" TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3)     NOT NULL,
    CONSTRAINT "risk_site_votes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "risk_site_votes_verdict_check" CHECK ("verdict" IN ('yes', 'no'))
);

CREATE UNIQUE INDEX "risk_site_votes_site_key_user_id_key" ON "risk_site_votes"("site_key", "user_id");
CREATE INDEX "risk_site_votes_site_key_verdict_idx" ON "risk_site_votes"("site_key", "verdict");
CREATE INDEX "risk_site_votes_user_id_idx" ON "risk_site_votes"("user_id");
