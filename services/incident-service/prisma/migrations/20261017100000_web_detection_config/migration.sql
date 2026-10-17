-- specs/011: signal `internet` of DuplicateCheck. New versions are derived from the active ones
-- so values activated after the seed are kept. Seeded disabled: enable with a new checks version.

INSERT INTO "verification_configs" ("id", "key", "version", "value", "is_active")
SELECT uuid_generate_v4(), 'checks', 'checks@1.1.0',
  jsonb_set(
    jsonb_set("value", '{duplicate,version}', '"duplicate@2.1.0"'),
    '{duplicate,web}',
    '{"enabled":false,"dailyLimit":100,"maxImages":10,"batchSize":3,"maxCandidates":5,"maxResults":20,"callTimeoutMs":4000,"totalTimeoutMs":8000,"fetchTimeoutMs":2000,"fetchMaxBytes":5000000,"cacheTtlDays":30,"blockedHosts":[]}'
  ),
  false
FROM "verification_configs" WHERE "key" = 'checks' AND "is_active";

-- DuplicateCheck can now run up to 8 s longer; 10 s would turn it FAILED (specs/011 research R10).
INSERT INTO "verification_configs" ("id", "key", "version", "value", "is_active")
SELECT uuid_generate_v4(), 'pipeline', '2.4.0', jsonb_set("value", '{checkTimeoutMs}', '20000'), false
FROM "verification_configs" WHERE "key" = 'pipeline' AND "is_active";

-- Switch: deactivate first, the partial unique index allows one active row per key.
UPDATE "verification_configs" SET "is_active" = false
WHERE "is_active" AND (("key" = 'checks' AND "version" <> 'checks@1.1.0') OR ("key" = 'pipeline' AND "version" <> '2.4.0'));
UPDATE "verification_configs" SET "is_active" = true
WHERE ("key" = 'checks' AND "version" = 'checks@1.1.0') OR ("key" = 'pipeline' AND "version" = '2.4.0');
