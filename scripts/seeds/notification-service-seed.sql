-- Notification service seed
-- Usage: psql "<notification DATABASE_URL>" -f be/scripts/seeds/notification-service-seed.sql

BEGIN;

INSERT INTO notifications ("id", "userId", "type", "kind", "title", "body", "htmlBody", "payload", "readAt", "createdAt")
VALUES
  (
    '33333333-3333-3333-3333-333333333301',
    '11111111-1111-1111-1111-111111111142',
    'WEBSITE',
    'GENERIC',
    'Welcome to EcoLink',
    'Your account has been seeded successfully.',
    '<p>Your account has been seeded successfully.</p>',
    '{"source":"seed","priority":"normal"}',
    NULL,
    '2026-01-01T00:00:00Z'
  ),
  (
    '33333333-3333-3333-3333-333333333302',
    '11111111-1111-1111-1111-111111111142',
    'EMAIL',
    'REPORT_STATUS',
    'Report updated',
    'Your report status has changed to IN_REVIEW.',
    '<p>Your report status has changed to <strong>IN_REVIEW</strong>.</p>',
    '{"reportId":"44444444-4444-4444-4444-444444444451"}',
    NULL,
    '2026-01-01T00:00:00Z'
  )
ON CONFLICT ("id") DO NOTHING;

INSERT INTO notification_jobs ("id", "job_type", "payload", "status", "attempts", "max_attempts", "processed_at", "created_at", "updated_at")
VALUES
  (
    '33333333-3333-3333-3333-333333333311',
    'SEND_EMAIL',
    '{"to":"user1@ecolink.local","subject":"Welcome","kind":"GENERIC"}',
    10,
    1,
    5,
    '2026-01-01T00:05:00Z',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:05:00Z'
  )
ON CONFLICT ("id") DO NOTHING;

COMMIT;
