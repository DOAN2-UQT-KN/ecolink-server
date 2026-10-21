-- Reward service seed
-- Usage: psql "<reward DATABASE_URL>" -f be/scripts/seeds/reward-service-seed.sql

BEGIN;

INSERT INTO difficulties ("id", "level", "name", "max_volunteers", "green_points", "created_at", "updated_at", "deleted_at")
VALUES
  ('22222222-2222-2222-2222-222222222201', 1, 'easy', 10, 10, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL),
  ('22222222-2222-2222-2222-222222222202', 2, 'medium', 25, 20, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL),
  ('22222222-2222-2222-2222-222222222203', 3, 'hard', 40, 30, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL),
  ('22222222-2222-2222-2222-222222222204', 4, 'very_hard', NULL, 40, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL)
ON CONFLICT ("level") DO UPDATE
SET
  "name" = EXCLUDED."name",
  "max_volunteers" = EXCLUDED."max_volunteers",
  "green_points" = EXCLUDED."green_points",
  "updated_at" = EXCLUDED."updated_at",
  "deleted_at" = NULL;

INSERT INTO gifts ("id", "name", "media_id", "description", "green_points", "stock_remaining", "is_active", "created_at", "updated_at", "deleted_at")
VALUES
  ('22222222-2222-2222-2222-222222222221', 'Eco Bottle', '33333333-3333-3333-3333-333333333331', 'Reusable water bottle reward', 100, 50, TRUE, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO gift_redemptions ("id", "user_id", "gift_id", "green_points_spent", "created_at")
VALUES
  ('22222222-2222-2222-2222-222222222241', '11111111-1111-1111-1111-111111111142', '22222222-2222-2222-2222-222222222221', 100, '2026-01-01T00:00:00Z')
ON CONFLICT ("id") DO NOTHING;

-- Earned 100, spent 100 on the redemption above: ledger sums to 0, matching no lots left (spec 014).
INSERT INTO green_point_transactions ("id", "user_id", "type", "resource_id", "resource_type", "points", "idempotency_key", "created_at", "updated_at", "deleted_at")
VALUES
  ('22222222-2222-2222-2222-222222222231', '11111111-1111-1111-1111-111111111142', 'CAMPAIGN_COMPLETION', '44444444-4444-4444-4444-444444444441', 'CAMPAIGN', 100, 'campaign_completion:44444444-4444-4444-4444-444444444441', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL),
  ('22222222-2222-2222-2222-222222222232', '11111111-1111-1111-1111-111111111142', 'GIFT_REDEEM', '22222222-2222-2222-2222-222222222241', 'GIFT_REDEMPTION', -100, 'gift_redeem:22222222-2222-2222-2222-222222222241', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL)
ON CONFLICT ("id") DO NOTHING;

-- Point rules: earning rates and point expiry days.
INSERT INTO gamification_point_rules (
  "id",
  "base_report_point",
  "report_milestone_thresholds",
  "campaign_completion_points",
  "report_completion_points",
  "point_expiration_days",
  "is_active",
  "effective_from",
  "created_at",
  "updated_at"
)
VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
  5,
  ARRAY[10, 20, 50, 100]::INTEGER[],
  20,
  0,
  90,
  TRUE,
  '2026-01-01T00:00:00Z',
  '2026-01-01T00:00:00Z',
  '2026-01-01T00:00:00Z'
)
ON CONFLICT ("id") DO UPDATE SET
  "base_report_point" = EXCLUDED."base_report_point",
  "report_milestone_thresholds" = EXCLUDED."report_milestone_thresholds",
  "campaign_completion_points" = EXCLUDED."campaign_completion_points",
  "report_completion_points" = EXCLUDED."report_completion_points",
  "point_expiration_days" = EXCLUDED."point_expiration_days",
  "updated_at" = EXCLUDED."updated_at";

COMMIT;
