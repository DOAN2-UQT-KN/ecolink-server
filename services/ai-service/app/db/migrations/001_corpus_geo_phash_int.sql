-- specs/006 P06: corpus columns for global pHash search and candidate filtering. Idempotent.
ALTER TABLE ai_media_content_hashes ADD COLUMN IF NOT EXISTS phash_int BIGINT;
ALTER TABLE ai_media_content_hashes ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
ALTER TABLE ai_media_content_hashes ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
ALTER TABLE ai_media_content_hashes ADD COLUMN IF NOT EXISTS report_created_at TIMESTAMPTZ;
ALTER TABLE ai_media_content_hashes ADD COLUMN IF NOT EXISTS category VARCHAR(32);
ALTER TABLE ai_media_orb_features ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
ALTER TABLE ai_media_orb_features ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
ALTER TABLE ai_media_orb_features ADD COLUMN IF NOT EXISTS report_created_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS ix_ai_media_content_hashes_report_created_at ON ai_media_content_hashes (report_created_at);
CREATE INDEX IF NOT EXISTS ix_ai_media_orb_features_report_created_at ON ai_media_orb_features (report_created_at);
-- SHA-256 is no longer used (FR-021): every SHA hit is also a pHash distance 0.
DELETE FROM ai_media_content_hashes WHERE algorithm = 'SHA256';
UPDATE ai_media_content_hashes
SET phash_int = ('x' || lpad(hash, 16, '0'))::bit(64)::bigint
WHERE algorithm = 'PHASH' AND phash_int IS NULL AND hash ~ '^[0-9a-fA-F]{16}$';
