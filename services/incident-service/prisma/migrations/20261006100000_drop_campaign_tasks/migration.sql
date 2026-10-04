-- Drop the Campaign Task feature (tasks, assignments, results, result files).
-- Order follows FK dependencies: result_files -> results -> assignments -> tasks.
DROP TABLE IF EXISTS "campaign_task_result_files";
DROP TABLE IF EXISTS "campaign_task_results";
DROP TABLE IF EXISTS "campaign_task_assignments";
DROP TABLE IF EXISTS "campaign_tasks";

-- Media rows that only served task results are no longer referenced.
DELETE FROM "media" WHERE "type" = 'CAMPAIGN_TASK_RESULT';
