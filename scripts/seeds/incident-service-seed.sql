-- Incident service seed
-- Usage: psql "<incident DATABASE_URL>" -f be/scripts/seeds/incident-service-seed.sql

BEGIN;

-- organizations
INSERT INTO organizations ("id", "name", "description", "logo_url", "background_url", "contact_email", "is_email_verified", "status", "owner_id", "created_by", "updated_by", "created_at", "updated_at", "deleted_at")
VALUES
  (
    '44444444-4444-4444-4444-444444444401',
    'Eco Volunteers',
    'Seeded organization for integration testing',
    'https://example.com/logo.png',
    'https://example.com/bg.png',
    'contact@ecovolunteers.local',
    TRUE,
    1,
    '11111111-1111-1111-1111-111111111141',
    '11111111-1111-1111-1111-111111111141',
    '11111111-1111-1111-1111-111111111141',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    NULL
  )
ON CONFLICT ("id") DO NOTHING;

-- campaigns
INSERT INTO campaigns ("id", "title", "description", "status", "difficulty", "is_verify", "organization_id", "created_by", "updated_by", "created_at", "updated_at", "deleted_at")
VALUES
  (
    '44444444-4444-4444-4444-444444444411',
    'Weekend River Cleanup',
    'Seed campaign',
    1,
    2,
    TRUE,
    '44444444-4444-4444-4444-444444444401',
    '11111111-1111-1111-1111-111111111141',
    '11111111-1111-1111-1111-111111111141',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    NULL
  )
ON CONFLICT ("id") DO NOTHING;

-- reports
INSERT INTO reports ("id", "campaign_id", "user_id", "title", "description", "waste_type", "severity_level", "latitude", "longitude", "detail_address", "status", "is_verify", "ai_verified", "created_by", "updated_by", "created_at", "updated_at", "deleted_at")
VALUES
  (
    '44444444-4444-4444-4444-444444444451',
    '44444444-4444-4444-4444-444444444411',
    '11111111-1111-1111-1111-111111111142',
    'Trash near river bank',
    'Plastic and cans scattered around the river',
    'PLASTIC',
    3,
    10.7769,
    106.7009,
    'District 1, Ho Chi Minh City',
    10,
    TRUE,
    TRUE,
    '11111111-1111-1111-1111-111111111142',
    '11111111-1111-1111-1111-111111111142',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    NULL
  )
ON CONFLICT ("id") DO NOTHING;

-- media
INSERT INTO media ("id", "url", "type", "created_by", "updated_by", "created_at", "updated_at", "deleted_at")
VALUES
  (
    '44444444-4444-4444-4444-444444444461',
    'https://example.com/report-1.jpg',
    'IMAGE',
    '11111111-1111-1111-1111-111111111142',
    '11111111-1111-1111-1111-111111111142',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    NULL
  ),
  (
    '44444444-4444-4444-4444-444444444462',
    'https://example.com/campaign-result-1.jpg',
    'IMAGE',
    '11111111-1111-1111-1111-111111111141',
    '11111111-1111-1111-1111-111111111141',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    NULL
  )
ON CONFLICT ("id") DO NOTHING;

-- report_media_files
INSERT INTO report_media_files ("id", "report_id", "media_id", "uploaded_by", "created_by", "updated_by", "created_at", "updated_at", "deleted_at")
VALUES
  (
    '44444444-4444-4444-4444-444444444471',
    '44444444-4444-4444-4444-444444444451',
    '44444444-4444-4444-4444-444444444461',
    '11111111-1111-1111-1111-111111111142',
    '11111111-1111-1111-1111-111111111142',
    '11111111-1111-1111-1111-111111111142',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    NULL
  )
ON CONFLICT ("id") DO NOTHING;

-- report_issues
INSERT INTO report_issues ("id", "report_id", "reporter_id", "issue_type", "description", "media_file_url", "created_by", "updated_by", "created_at", "updated_at", "deleted_at")
VALUES
  (
    '44444444-4444-4444-4444-444444444481',
    '44444444-4444-4444-4444-444444444451',
    '11111111-1111-1111-1111-111111111141',
    'DUPLICATE',
    'Potential duplicate report in same area',
    'https://example.com/issue-proof.jpg',
    '11111111-1111-1111-1111-111111111141',
    '11111111-1111-1111-1111-111111111141',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    NULL
  )
ON CONFLICT ("id") DO NOTHING;

-- campaign_managers
INSERT INTO campaign_managers ("campaign_id", "user_id", "assigned_by", "assigned_at", "created_by", "updated_by", "created_at", "updated_at", "deleted_at")
VALUES
  (
    '44444444-4444-4444-4444-444444444411',
    '11111111-1111-1111-1111-111111111141',
    '11111111-1111-1111-1111-111111111141',
    '2026-01-01T00:00:00Z',
    '11111111-1111-1111-1111-111111111141',
    '11111111-1111-1111-1111-111111111141',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    NULL
  )
ON CONFLICT ("campaign_id", "user_id") DO NOTHING;

-- campaign_joining_requests
INSERT INTO campaign_joining_requests ("id", "campaign_id", "volunteer_id", "status", "created_by", "updated_by", "created_at", "updated_at", "deleted_at")
VALUES
  (
    '44444444-4444-4444-4444-444444444491',
    '44444444-4444-4444-4444-444444444411',
    '11111111-1111-1111-1111-111111111142',
    13,
    '11111111-1111-1111-1111-111111111142',
    '11111111-1111-1111-1111-111111111141',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    NULL
  )
ON CONFLICT ("id") DO NOTHING;

-- campaign_tasks
INSERT INTO campaign_tasks ("id", "campaign_id", "title", "description", "status", "scheduled_time", "created_by", "updated_by", "created_at", "updated_at", "deleted_at")
VALUES
  (
    '44444444-4444-4444-4444-444444444501',
    '44444444-4444-4444-4444-444444444411',
    'Collect plastics',
    'Gather plastics around river edge',
    21,
    '2026-01-03T08:00:00Z',
    '11111111-1111-1111-1111-111111111141',
    '11111111-1111-1111-1111-111111111141',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    NULL
  )
ON CONFLICT ("id") DO NOTHING;

-- campaign_task_assignments
INSERT INTO campaign_task_assignments ("id", "campaign_task_id", "volunteer_id", "created_by", "updated_by", "created_at", "updated_at", "deleted_at")
VALUES
  (
    '44444444-4444-4444-4444-444444444511',
    '44444444-4444-4444-4444-444444444501',
    '11111111-1111-1111-1111-111111111142',
    '11111111-1111-1111-1111-111111111141',
    '11111111-1111-1111-1111-111111111141',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    NULL
  )
ON CONFLICT ("id") DO NOTHING;

-- campaign_submissions
INSERT INTO campaign_submissions ("id", "campaign_id", "submitted_by", "title", "description", "status", "created_by", "updated_by", "created_at", "updated_at", "deleted_at")
VALUES
  (
    '44444444-4444-4444-4444-444444444521',
    '44444444-4444-4444-4444-444444444411',
    '11111111-1111-1111-1111-111111111141',
    'Week 1 submission',
    'Initial cleanup result submission',
    10,
    '11111111-1111-1111-1111-111111111141',
    '11111111-1111-1111-1111-111111111141',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    NULL
  )
ON CONFLICT ("id") DO NOTHING;

-- campaign_results
INSERT INTO campaign_results ("id", "campaign_id", "campaign_submission_id", "title", "description", "created_by", "updated_by", "created_at", "updated_at", "deleted_at")
VALUES
  (
    '44444444-4444-4444-4444-444444444531',
    '44444444-4444-4444-4444-444444444411',
    '44444444-4444-4444-4444-444444444521',
    'Removed 20kg waste',
    'Collected and sorted waste from river bank',
    '11111111-1111-1111-1111-111111111141',
    '11111111-1111-1111-1111-111111111141',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    NULL
  )
ON CONFLICT ("id") DO NOTHING;

-- campaign_result_files
INSERT INTO campaign_result_files ("id", "campaign_result_id", "media_id", "created_by", "updated_by", "created_at", "updated_at")
VALUES
  (
    '44444444-4444-4444-4444-444444444541',
    '44444444-4444-4444-4444-444444444531',
    '44444444-4444-4444-4444-444444444462',
    '11111111-1111-1111-1111-111111111141',
    '11111111-1111-1111-1111-111111111141',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z'
  )
ON CONFLICT ("id") DO NOTHING;

-- ai_analysis_logs
INSERT INTO ai_analysis_logs ("id", "report_id", "report_media_file_id", "media_id", "detections", "created_by", "updated_by", "processed_at", "created_at", "updated_at")
VALUES
  (
    '44444444-4444-4444-4444-444444444551',
    '44444444-4444-4444-4444-444444444451',
    '44444444-4444-4444-4444-444444444471',
    '44444444-4444-4444-4444-444444444461',
    7,
    '11111111-1111-1111-1111-111111111142',
    '11111111-1111-1111-1111-111111111142',
    '2026-01-01T00:10:00Z',
    '2026-01-01T00:10:00Z',
    '2026-01-01T00:10:00Z'
  )
ON CONFLICT ("id") DO NOTHING;

-- background_jobs
INSERT INTO background_jobs ("id", "job_type", "payload", "status", "attempts", "max_attempts", "run_after", "created_by", "updated_by", "processed_at", "created_at", "updated_at")
VALUES
  (
    '44444444-4444-4444-4444-444444444561',
    'REPORT_AI_ANALYSIS',
    '{"reportId":"44444444-4444-4444-4444-444444444451"}',
    10,
    1,
    5,
    '2026-01-01T00:00:00Z',
    '11111111-1111-1111-1111-111111111141',
    '11111111-1111-1111-1111-111111111141',
    '2026-01-01T00:15:00Z',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:15:00Z'
  )
ON CONFLICT ("id") DO NOTHING;

-- votes
INSERT INTO votes ("id", "user_id", "value", "resource_type", "resource_id", "created_at", "updated_at", "deleted_at")
VALUES
  (
    '44444444-4444-4444-4444-444444444571',
    '11111111-1111-1111-1111-111111111142',
    1,
    'REPORT',
    '44444444-4444-4444-4444-444444444451',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    NULL
  )
ON CONFLICT ("user_id", "resource_type", "resource_id") DO NOTHING;

-- saved_resources
INSERT INTO saved_resources ("id", "user_id", "resource_id", "resource_type", "created_at", "updated_at", "deleted_at")
VALUES
  (
    '44444444-4444-4444-4444-444444444581',
    '11111111-1111-1111-1111-111111111142',
    '44444444-4444-4444-4444-444444444411',
    'CAMPAIGN',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    NULL
  )
ON CONFLICT ("user_id", "resource_type", "resource_id") DO NOTHING;

-- organization_members
INSERT INTO organization_members ("organization_id", "user_id", "created_by", "updated_by", "created_at", "updated_at", "deleted_at")
VALUES
  (
    '44444444-4444-4444-4444-444444444401',
    '11111111-1111-1111-1111-111111111142',
    '11111111-1111-1111-1111-111111111141',
    '11111111-1111-1111-1111-111111111141',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    NULL
  )
ON CONFLICT ("organization_id", "user_id") DO NOTHING;

-- organization_joining_requests
INSERT INTO organization_joining_requests ("id", "organization_id", "requester_id", "status", "created_by", "updated_by", "created_at", "updated_at", "deleted_at")
VALUES
  (
    '44444444-4444-4444-4444-444444444591',
    '44444444-4444-4444-4444-444444444401',
    '11111111-1111-1111-1111-111111111142',
    13,
    '11111111-1111-1111-1111-111111111142',
    '11111111-1111-1111-1111-111111111141',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    NULL
  )
ON CONFLICT ("id") DO NOTHING;

COMMIT;
