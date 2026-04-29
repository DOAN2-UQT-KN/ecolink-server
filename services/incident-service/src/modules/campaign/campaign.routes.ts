import { Router } from "express";
import { authenticate } from "../../middleware/auth.middleware";
import { campaignController } from "./campaign.controller";
import { campaignSubmissionController } from "./campaign_submission/campaign_submission.controller";

const router = Router();

/**
 * @route   POST /api/v1/campaigns
 * @desc    Create a new campaign under an organization (must be that org's owner); optionally link reports
 * @access  Private
 * @body    { organizationId, title, description?, difficulty, reportIds? }
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
 * @route   PUT /api/v1/campaigns/:id/reject
 * @desc    Admin reject draft campaign (status → inactive; linked reports return to pending)
 * @access  Private (Admin only)
 */
router.put("/:id/reject", authenticate, campaignController.adminRejectCampaign);

/**
 * @route   PUT /api/v1/campaigns/:id/verify
 * @desc    Admin-approve campaign (status → active, is_verify)
 * @access  Private (Admin only)
 */
router.put("/:id/verify", authenticate, campaignController.adminVerifyCampaign);

/**
 * @route   PUT /api/v1/campaigns/:id/mark-done
 * @desc    Mark campaign completed (admin). Must be active; green points TBD.
 * @access  Private (Admin only)
 */
router.put("/:id/mark-done", authenticate, campaignController.markCampaignDone);

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
 * @route   POST /api/v1/campaigns/volunteers/join-requests
 * @desc    Create a join request for a campaign
 * @access  Private
 * @body    { campaignId }
 */
router.post(
  "/volunteers/join-requests",
  authenticate,
  campaignController.createJoinRequest,
);

/**
 * @route   GET /api/v1/campaigns/volunteers/join-requests
 * @desc    List join requests for a campaign with filters and pagination (managers only)
 * @access  Private
 * @query   campaignId (required), status?, volunteerId?, page, limit, sortBy (createdAt|updatedAt), sortOrder (asc|desc)
 */
router.get(
  "/volunteers/join-requests",
  authenticate,
  campaignController.getJoinRequests,
);

/**
 * @route   GET /api/v1/campaigns/volunteers/join-requests/my
 * @desc    My join requests with optional filters and pagination
 * @access  Private
 * @query   campaignId?, status?, page, limit, sortBy (createdAt|updatedAt), sortOrder (asc|desc)
 */
router.get(
  "/volunteers/join-requests/my",
  authenticate,
  campaignController.getMyJoinRequests,
);

/**
 * @route   PUT /api/v1/campaigns/volunteers/join-requests/process
 * @desc    Approve or reject a join request (campaign managers only)
 * @access  Private
 * @body    { requestId, approved }
 */
router.put(
  "/volunteers/join-requests/process",
  authenticate,
  campaignController.processJoinRequest,
);

/**
 * @route   DELETE /api/v1/campaigns/volunteers/join-requests/cancel
 * @desc    Cancel a join request (volunteer only)
 * @access  Private
 * @body    { requestId }
 */
router.delete(
  "/volunteers/join-requests/cancel",
  authenticate,
  campaignController.cancelJoinRequest,
);

/**
 * @route   GET /api/v1/campaigns/volunteers/approved
 * @desc    List approved volunteers for a campaign (managers only), with filters and pagination
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
