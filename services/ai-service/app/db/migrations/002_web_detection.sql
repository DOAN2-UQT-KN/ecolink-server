-- specs/011: cache and daily counter of the duplicate signal `internet`. Idempotent.
CREATE TABLE IF NOT EXISTS ai_web_detection_cache (
    phash VARCHAR(16) PRIMARY KEY,
    candidates JSONB NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ai_web_detection_cache_expires_at ON ai_web_detection_cache (expires_at);
CREATE TABLE IF NOT EXISTS ai_web_detection_usage (
    day DATE PRIMARY KEY,
    calls INTEGER NOT NULL DEFAULT 0
);
