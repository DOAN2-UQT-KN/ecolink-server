-- Campaigns approved before UPCOMING (27) existed went straight to ACTIVE (1). Those whose first
-- day has not started yet are upcoming: move them, so they stay editable (spec 3.5) and the
-- lifecycle job starts them on their first day. Each move is logged.
-- Rollback: UPDATE "campaigns" SET "status" = 1 WHERE "id" IN (SELECT "campaign_id" FROM
--   "campaign_status_logs" WHERE "event" = 'backfill_upcoming');

WITH moved AS (
  UPDATE "campaigns" c
  SET "status" = 27, "updated_at" = CURRENT_TIMESTAMP
  WHERE c."status" = 1
    AND c."deleted_at" IS NULL
    AND EXISTS (SELECT 1 FROM "campaign_days" d WHERE d."campaign_id" = c."id")
    AND NOT EXISTS (
      SELECT 1 FROM "campaign_days" d
      WHERE d."campaign_id" = c."id" AND d."start_at" <= CURRENT_TIMESTAMP
    )
  RETURNING c."id"
)
INSERT INTO "campaign_status_logs" ("id", "campaign_id", "type", "event", "from_status", "to_status", "actor_role", "reason")
SELECT gen_random_uuid(), "id", 'STATUS_CHANGE', 'backfill_upcoming', 1, 27, 'system', 'approved_before_upcoming_existed'
FROM moved;
