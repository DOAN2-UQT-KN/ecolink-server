import { Router } from "express";
import { authenticate } from "../../middleware/auth.middleware";
import { campaignController } from "./campaign.controller";
import { campaignCompletionVerificationController } from "./campaign_completion_verification/campaign_completion_verification.controller";
import { campaignSubmissionController } from "./campaign_submission/campaign_submission.controller";

const router = Router();

/**
 * @route   POST /api/v1/campaigns
 * @desc    Create a new campaign under an organization (must be that org's owner); optionally link reports
 * @access  Private
 * @body    { organizationId, title, description?, difficulty, reportIds?, latitude?, longitude? }
 */
router.post("/", authenticate, campaignController.createCampaign);

/**
 * @route   GET /api/v1/campaigns
 * @desc    List campaigns with optional filters and pagination
 * @access  Private
 * @query   search?, status?, createdBy?, managerId?, page, limit, sortBy (createdAt|updatedAt|title), sortOrder (asc|desc)
 */
router.get("/", authenticate, campaignController.getCampaigns);

/**
 * @route   GET /api/v1/campaigns/all
 * @desc    All campaigns with status ACTIVE only (no pagination)
 * @access  Private
 */
router.get("/all", authenticate, campaignController.getAllActiveCampaigns);

/**
 * @route   GET /api/v1/campaigns/by-ids
 * @desc    Campaigns by campaignIds (max 100 UUIDs)
 * @access  Private
 * @query   campaignIds — comma-separated or repeated
 */
router.get("/by-ids", authenticate, campaignController.getCampaignsByIds);

/**
 * @route   GET /api/v1/campaigns/create-eligibility
 * @desc    Whether the caller may create a campaign for the organization, with reasons
 * @access  Private
 * @query   organizationId
 */
router.get(
  "/create-eligibility",
  authenticate,
  campaignController.getCreateEligibility,
);

/**
 * @route   GET /api/v1/campaigns/my
 * @desc    List campaigns that the user is owner or their join request is approved
 * @access  Private
 * @query   search?, status?, page, limit, sortBy (createdAt|updatedAt|title), sortOrder (asc|desc), greenPointsFrom?, greenPointsTo?
 */
router.get("/my", authenticate, campaignController.getMyCampaigns);

/**
 * @route   GET /api/v1/campaigns/admin/awaiting-multi-submission-review
 * @desc    Campaigns with more than one submission awaiting approve/reject (admin)
 * @access  Private (Admin only)
 * @query   page, limit, sortBy (createdAt|updatedAt|title), sortOrder (asc|desc)
 */
router.get(
  "/admin/awaiting-multi-submission-review",
  authenticate,
  campaignController.getCampaignsAwaitingMultiSubmissionReview,
);

/**
 * @route   GET /api/v1/campaigns/tasks/my-assigned
 * @desc    Tasks assigned to the current user (volunteer)
 * @access  Private
 */
router.get(
  "/tasks/my-assigned",
  authenticate,
  campaignController.getMyAssignedTasks,
);

/**
 * @route   GET /api/v1/campaigns/tasks/:taskId
 * @desc    Task detail with assignments
 * @access  Private
 */
router.get("/tasks/:taskId", authenticate, campaignController.getTaskById);

/**
 * @route   PUT /api/v1/campaigns/tasks/:taskId
 * @desc    Update a task
 * @access  Private
 */
router.put("/tasks/:taskId", authenticate, campaignController.updateTask);

/**
 * @route   DELETE /api/v1/campaigns/tasks/:taskId
 * @desc    Soft-delete a task
 * @access  Private
 */
router.delete("/tasks/:taskId", authenticate, campaignController.deleteTask);

/**
 * @route   POST /api/v1/campaigns/tasks/:taskId/assign
 * @desc    Assign a volunteer to a task
 * @access  Private
 * @body    { volunteerId }
 */
router.post(
  "/tasks/:taskId/assign",
  authenticate,
  campaignController.assignTask,
);

/**
 * @route   POST /api/v1/campaigns/tasks/:taskId/unassign
 * @desc    Unassign a volunteer from a task
 * @access  Private
 * @body    { volunteerId }
 */
router.post(
  "/tasks/:taskId/unassign",
  authenticate,
  campaignController.unassignTask,
);

/**
 * @route   PUT /api/v1/campaigns/tasks/:taskId/status
 * @desc    Update task status (assigned volunteer)
 * @access  Private
 * @body    { status }
 */
router.put(
  "/tasks/:taskId/status",
  authenticate,
  campaignController.updateTaskStatus,
);

/**
 * @route   GET /api/v1/campaigns/:id
 * @desc    Get campaign by ID
 * @access  Private
 */
router.get("/:id", authenticate, campaignController.getCampaignById);

/**
 * @route   PUT /api/v1/campaigns/:id/completion-review
 * @desc    Admin approve or reject pending completion (WAITING_CONFIRMED)
 * @access  Private (Admin only)
 */
router.put(
  "/:id/completion-review",
  authenticate,
  campaignController.adminReviewCampaignCompletion,
);

/**
 * @route   POST /api/v1/campaigns/:id/submit
 * @desc    Send a draft (or a campaign waiting for changes) for admin review; locks its reports
 * @access  Private (Campaign manager)
 */
router.post("/:id/submit", authenticate, campaignController.submitCampaign);

/**
 * @route   PUT /api/v1/campaigns/:id/review
 * @desc    Admin: approve, request_revision or block a campaign waiting for review
 * @access  Private (Admin only, not a member of the campaign's organization)
 * @body    { decision, reason? } — reason required unless approving
 */
router.put("/:id/review", authenticate, campaignController.reviewCampaign);

/**
 * @route   POST /api/v1/campaigns/:id/cancel
 * @desc    Cancel an upcoming, running, or approved-and-under-review campaign (creator or owner)
 * @access  Private
 * @body    { reason } — required
 */
router.post("/:id/cancel", authenticate, campaignController.cancelCampaign);

/**
 * @route   GET /api/v1/campaigns/:id/history
 * @desc    Status changes and edits under review
 * @access  Private (Campaign manager or admin)
 */
router.get("/:id/history", authenticate, campaignController.getCampaignHistory);

/**
 * @route   PUT /api/v1/campaigns/:id/verify
 * @desc    Deprecated, use /:id/review. status 1 approves, 2 blocks (or bans when running)
 * @access  Private (Admin only)
 */
router.put("/:id/verify", authenticate, campaignController.adminVerifyCampaign);

/**
 * @route   PUT /api/v1/campaigns/:id/mark-done
 * @desc    Manager: submit for final admin completion approval.
 * @access  Private
 */
router.put("/:id/mark-done", authenticate, campaignController.markCampaignDone);

/**
 * @route   POST /api/v1/campaigns/:id/completion-verification
 * @desc    Submit community completion verification (clean / not clean)
 * @access  Private
 */
router.post(
  "/:id/completion-verification",
  authenticate,
  campaignCompletionVerificationController.submit,
);

/**
 * @route   POST /api/v1/campaigns/:id/attendance-qr, POST /api/v1/campaigns/:id/attendance-check-in
 * @desc    Legacy per-campaign attendance: 410, attendance is per shift (spec 4.1)
 * @access  Private
 */
router.post("/:id/attendance-qr", authenticate, campaignController.legacyAttendanceGone);
router.post("/:id/attendance-check-in", authenticate, campaignController.legacyAttendanceGone);

/**
 * @route   POST /api/v1/campaigns/:id/attendance/scan
 * @desc    Check in (first scan) or out (later scan) with a shift's dynamic QR and the device's GPS
 * @access  Private
 * @body    { token, latitude, longitude, accuracy, scannedAt? }
 */
router.post("/:id/attendance/scan", authenticate, campaignController.scanAttendance);

/**
 * @route   POST /api/v1/campaigns/:id/shifts/:shiftId/attendance/session
 * @desc    Open the shift's QR session (up to 60 minutes) or return the open one (leader or managers)
 * @access  Private
 */
router.post(
  "/:id/shifts/:shiftId/attendance/session",
  authenticate,
  campaignController.openAttendanceSession,
);

/**
 * @route   GET /api/v1/campaigns/:id/shifts/:shiftId/attendance/qr
 * @desc    The current dynamic code of the open session; ask again every `periodSec`
 * @access  Private (leader or managers)
 */
router.get("/:id/shifts/:shiftId/attendance/qr", authenticate, campaignController.getAttendanceQr);

/**
 * @route   POST /api/v1/campaigns/:id/shifts/:shiftId/attendance/close
 * @desc    Close the sessions and check out everyone still checked in (leader or managers)
 * @access  Private
 */
router.post(
  "/:id/shifts/:shiftId/attendance/close",
  authenticate,
  campaignController.closeAttendance,
);

/**
 * @route   POST /api/v1/campaigns/:id/shifts/:shiftId/attendance/manual
 * @desc    Record someone by hand with a reason; at most 20% of those present (leader or managers)
 * @access  Private
 * @body    { userId, reason, checkInAt? }
 */
router.post(
  "/:id/shifts/:shiftId/attendance/manual",
  authenticate,
  campaignController.addManualAttendance,
);

/**
 * @route   POST /api/v1/campaigns/:id/shifts/:shiftId/attendance/:userId/exclude
 * @desc    Take an attendance out of the points (e.g. a flagged scan), with a reason (leader or managers)
 * @access  Private
 * @body    { reason }
 */
router.post(
  "/:id/shifts/:shiftId/attendance/:userId/exclude",
  authenticate,
  campaignController.excludeAttendance,
);

/**
 * @route   POST /api/v1/campaigns/:id/shifts/:shiftId/attendance/:userId/restore
 * @desc    Put an excluded attendance back into the points (leader or managers)
 * @access  Private
 */
router.post(
  "/:id/shifts/:shiftId/attendance/:userId/restore",
  authenticate,
  campaignController.restoreAttendance,
);

/**
 * @route   GET /api/v1/campaigns/:id/shifts/:shiftId/attendance
 * @desc    Who is present on the shift, with eligibility (leader, managers, platform admins)
 * @access  Private
 */
router.get(
  "/:id/shifts/:shiftId/attendance",
  authenticate,
  campaignController.getShiftAttendance,
);

/**
 * @route   PUT /api/v1/campaigns/:id
 * @desc    Update campaign by ID
 * @access  Private (Campaign manager only)
 */
router.put("/:id", authenticate, campaignController.updateCampaign);

/**
 * @route   DELETE /api/v1/campaigns/:id
 * @desc    Soft delete campaign by ID
 * @access  Private (Campaign manager only)
 */
router.delete("/:id", authenticate, campaignController.deleteCampaign);

// =====================
// Campaign managers & tasks (scoped by campaign id)
// =====================

/**
 * @route   POST /api/v1/campaigns/:id/add-managers
 * @access  Private
 * @body    { userIds: string[] }
 */
router.post("/:id/add-managers", authenticate, campaignController.addManagers);

/**
 * @route   POST /api/v1/campaigns/:id/remove-manager
 * @access  Private
 * @body    { userId }
 */
router.post(
  "/:id/remove-manager",
  authenticate,
  campaignController.removeManager,
);

/**
 * @route   GET /api/v1/campaigns/:id/managers
 * @access  Private
 * @query   userId?, page, limit, sortBy (assignedAt|userId|createdAt), sortOrder (asc|desc)
 */
router.get(
  "/:id/managers",
  authenticate,
  campaignController.getCampaignManagers,
);

/**
 * @route   POST /api/v1/campaigns/:id/tasks
 * @access  Private
 * @body    { title, description?, priority?: 1|2|3, scheduledDate?, scheduledTime? }
 */
router.post("/:id/tasks", authenticate, campaignController.createTask);

/**
 * @route   GET /api/v1/campaigns/:id/tasks
 * @access  Private
 */
router.get("/:id/tasks", authenticate, campaignController.getCampaignTasks);

// =====================
// Joining Request Routes
// =====================

/**
 * @route   GET /api/v1/campaigns/:id/registration-options
 * @desc    Shifts the caller can register for, with counts, overlaps and their absence record
 * @access  Private
 */
router.get(
  "/:id/registration-options",
  authenticate,
  campaignController.getRegistrationOptions,
);

/**
 * @route   PUT /api/v1/campaigns/:id/registrations/me
 * @desc    Replace the caller's shifts (no approval, never capped); [] leaves the campaign
 * @access  Private
 * @body    { shiftIds: string[], acceptConditions?: boolean }
 */
router.put(
  "/:id/registrations/me",
  authenticate,
  campaignController.updateMyRegistrations,
);

/**
 * @route   GET /api/v1/campaigns/:id/registrations
 * @desc    Each shift with the people registered for it, read only (managers, registered volunteers, admins), and when nearby residents may be invited again
 * @access  Private
 */
router.get(
  "/:id/registrations",
  authenticate,
  campaignController.getCampaignRegistrations,
);

/**
 * @route   POST /api/v1/campaigns/:id/invite-nearby
 * @desc    Invite residents within 5 km of the meeting points to fill short shifts (managers, once per 24 h)
 * @access  Private
 */
router.post("/:id/invite-nearby", authenticate, campaignController.inviteNearby);

/**
 * @route   POST /api/v1/campaigns/:id/shifts/:shiftId/close
 * @desc    Turn a shift off before it starts; its volunteers are told to pick another shift (managers)
 * @access  Private
 */
router.post("/:id/shifts/:shiftId/close", authenticate, campaignController.closeShift);

/**
 * @route   PUT /api/v1/campaigns/:id/shifts/:shiftId/leader
 * @desc    Choose who leads a shift that has not ended; must be on the campaign's team (managers)
 * @access  Private
 * @body    { leaderUserId }
 */
router.put("/:id/shifts/:shiftId/leader", authenticate, campaignController.setShiftLeader);

/**
 * @route   GET /api/v1/campaigns/volunteers/approved
 * @desc    People registered for at least one shift (managers, volunteers, admins), paginated
 * @access  Private
 * @query   campaignId (required), volunteerId?, page, limit, sortBy (createdAt|updatedAt), sortOrder (asc|desc)
 */
router.get(
  "/volunteers/approved",
  authenticate,
  campaignController.getApprovedVolunteers,
);

// =====================
// Submission Routes
// =====================

/**
 * @route   POST /api/v1/campaigns/:id/submissions
 * @desc    Create a submission (title, description in body); attach draft results from the DB
 * @access  Private (Campaign manager only)
 */
router.post(
  "/:id/submissions",
  authenticate,
  campaignSubmissionController.createSubmission,
);

/**
 * @route   GET /api/v1/campaigns/:id/submissions
 * @desc    List submissions with optional filters and pagination
 * @access  Private
 * @query   status?, submittedBy?, search?, page, limit, sortBy (createdAt|updatedAt|title), sortOrder (asc|desc)
 */
router.get(
  "/:id/submissions",
  authenticate,
  campaignSubmissionController.getSubmissions,
);

/**
 * @route   GET /api/v1/campaigns/:id/submissions/current-results
 * @desc    Draft results for this campaign (not yet submitted / no submission id)
 * @access  Private
 */
router.get(
  "/:id/submissions/current-results",
  authenticate,
  campaignSubmissionController.getCurrentResults,
);

/**
 * @route   GET /api/v1/campaigns/submissions/:submissionId
 * @desc    Get submission detail (with all results and files)
 * @access  Private
 */
router.get(
  "/submissions/:submissionId",
  authenticate,
  campaignSubmissionController.getSubmissionDetail,
);

/**
 * @route   POST /api/v1/campaigns/submissions/:submissionId/results
 * @desc    Add a result to an existing submission
 * @access  Private (Submitter only)
 */
router.post(
  "/submissions/:submissionId/results",
  authenticate,
  campaignSubmissionController.addResult,
);

/**
 * @route   PUT /api/v1/campaigns/submissions/:submissionId/process
 * @desc    Approve or reject a submission
 * @access  Private (Campaign manager only)
 * @body    { approved }
 */
router.put(
  "/submissions/:submissionId/process",
  authenticate,
  campaignSubmissionController.processSubmission,
);

export default router;
