-- One-off, manual: deletes every campaign and everything hanging off it, and frees the
-- waste points they held. Used on a dev database when the campaign schedule moved to
-- days x shifts (2026-09-30); old campaigns were not migrated. Back up first:
--   docker exec postgres-ecolink pg_dump -U postgres -Fc incidentdb > backup.dump
-- Run with:
--   docker exec -i postgres-ecolink psql -U postgres -d incidentdb -v ON_ERROR_STOP=1 < prisma/scripts/wipe-campaigns.sql
BEGIN;

-- Waste points go back to approved-and-free: TODO 21 (same as releaseAllReports).
UPDATE reports SET status = 21, campaign_id = NULL WHERE campaign_id IS NOT NULL AND status = 22;
UPDATE reports SET campaign_id = NULL WHERE campaign_id IS NOT NULL;

DELETE FROM votes WHERE resource_type = 'CAMPAIGN';
DELETE FROM saved_resources WHERE resource_type = 'CAMPAIGN';

DELETE FROM campaign_task_result_files;
DELETE FROM campaign_task_results;
DELETE FROM campaign_task_assignments;
DELETE FROM campaign_tasks;
DELETE FROM campaign_result_files;
DELETE FROM campaign_results;
DELETE FROM campaign_submissions;
DELETE FROM campaign_attendance_check_ins;
DELETE FROM campaign_joining_requests;
DELETE FROM campaign_shift_registrations;
DELETE FROM campaign_managers;
DELETE FROM sos;
DELETE FROM campaign_status_logs;
DELETE FROM campaign_shifts;
DELETE FROM campaign_days;
DELETE FROM campaign_meeting_point_reports;
DELETE FROM campaign_meeting_points;
DELETE FROM campaigns;

COMMIT;
