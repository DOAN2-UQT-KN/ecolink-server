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

INSERT INTO user_green_point_balances ("user_id", "balance", "created_at", "updated_at")
VALUES
  ('11111111-1111-1111-1111-111111111142', 150, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
ON CONFLICT ("user_id") DO UPDATE
SET
  "balance" = EXCLUDED."balance",
  "updated_at" = EXCLUDED."updated_at";

INSERT INTO gifts ("id", "name", "media_id", "description", "green_points", "stock_remaining", "is_active", "created_at", "updated_at", "deleted_at")
VALUES
  ('22222222-2222-2222-2222-222222222221', 'Eco Bottle', '33333333-3333-3333-3333-333333333331', 'Reusable water bottle reward', 100, 50, TRUE, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO green_point_transactions ("id", "user_id", "type", "resource_id", "resource_type", "points", "created_at", "updated_at", "deleted_at")
VALUES
  ('22222222-2222-2222-2222-222222222231', '11111111-1111-1111-1111-111111111142', 'CAMPAIGN_COMPLETION', '44444444-4444-4444-4444-444444444441', 'CAMPAIGN', 100, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO gift_redemptions ("id", "user_id", "gift_id", "green_points_spent", "created_at")
VALUES
  ('22222222-2222-2222-2222-222222222241', '11111111-1111-1111-1111-111111111142', '22222222-2222-2222-2222-222222222221', 100, '2026-01-01T00:00:00Z')
ON CONFLICT ("id") DO NOTHING;

-- Gamification v2 defaults (multipliers, citizen milestones, SP expiry, season cadence).
INSERT INTO gamification_point_rules (
  "id",
  "base_report_point",
  "report_milestone_thresholds",
  "volunteer_bonus_cap_by_difficulty",
  "is_active",
  "effective_from",
  "created_at",
  "updated_at"
)
VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
  5,
  ARRAY[10, 20, 50, 100]::INTEGER[],
  '{"1": 30, "2": 60, "3": 90, "4": 120}'::JSONB,
  TRUE,
  '2026-01-01T00:00:00Z',
  '2026-01-01T00:00:00Z',
  '2026-01-01T00:00:00Z'
)
ON CONFLICT ("id") DO UPDATE SET
  "base_report_point" = EXCLUDED."base_report_point",
  "report_milestone_thresholds" = EXCLUDED."report_milestone_thresholds",
  "volunteer_bonus_cap_by_difficulty" = EXCLUDED."volunteer_bonus_cap_by_difficulty",
  "updated_at" = EXCLUDED."updated_at";

INSERT INTO volunteer_org_multiplier_rules ("id", "code", "multiplier", "priority", "is_active", "created_at", "updated_at")
VALUES
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', 'MEMBER_OF_OWNER_ORG', 1.20, 100, TRUE, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2', 'PARTICIPANT_OTHER_ORG_CAMPAIGN', 1.10, 50, TRUE, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb3', 'DEFAULT', 1.00, 0, TRUE, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
ON CONFLICT ("code") DO UPDATE SET
  "multiplier" = EXCLUDED."multiplier",
  "priority" = EXCLUDED."priority",
  "is_active" = EXCLUDED."is_active",
  "updated_at" = EXCLUDED."updated_at";

INSERT INTO spendable_point_rules ("id", "expiration_days", "is_active", "effective_from", "created_at", "updated_at")
VALUES (
  'cccccccc-cccc-cccc-cccc-ccccccccccc1',
  90,
  TRUE,
  '2026-01-01T00:00:00Z',
  '2026-01-01T00:00:00Z',
  '2026-01-01T00:00:00Z'
)
ON CONFLICT ("id") DO UPDATE SET
  "expiration_days" = EXCLUDED."expiration_days",
  "updated_at" = EXCLUDED."updated_at";

INSERT INTO season_schedule_rules ("id", "season_kind", "auto_rotate", "metadata", "created_at", "updated_at")
VALUES
  ('dddddddd-dddd-dddd-dddd-dddddddddd01', 'MONTHLY', TRUE, '{"cronHint": "0 0 1 * *"}'::JSONB, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('dddddddd-dddd-dddd-dddd-dddddddddd02', 'QUARTERLY', TRUE, '{"cronHint": "0 0 1 */3 *"}'::JSONB, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
ON CONFLICT ("season_kind") DO UPDATE SET
  "auto_rotate" = EXCLUDED."auto_rotate",
  "metadata" = EXCLUDED."metadata",
  "updated_at" = EXCLUDED."updated_at";

COMMIT;
