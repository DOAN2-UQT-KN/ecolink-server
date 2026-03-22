import { Router } from "express";
import { reportController } from "./report.controller";
import { authenticate } from "../../middleware/auth.middleware";

const router = Router();

/**
 * @route   POST /api/v1/reports
 * @desc    Create a new report
 * @access  Private
 */
router.post("/", authenticate, reportController.createReport);

/**
 * @route   GET /api/v1/reports/search
 * @desc    Search and discover reports with filters and sorting
 * @access  Private
 */
router.get("/search", authenticate, reportController.searchReports);

/**
 * @route   GET /api/v1/reports/my
 * @desc    Get current user's reports
 * @access  Private
 */
router.get("/my", authenticate, reportController.getMyReports);

/**
 * @route   GET /api/v1/reports/:id
 * @desc    Get report by ID
 * @access  Private
 */
router.get("/:id", authenticate, reportController.getReportById);

/**
 * @route   GET /api/v1/reports/:id/detail
 * @desc    Get report with full details
 * @access  Private
 */
router.get("/:id/detail", authenticate, reportController.getReportDetail);

/**
 * @route   PUT /api/v1/reports/:id
 * @desc    Update a report
 * @access  Private
 */
router.put("/:id", authenticate, reportController.updateReport);

/**
 * @route   PUT /api/v1/reports/:id/mark-done
 * @desc    Mark report as completed (admin only, requires approved volunteers)
 * @access  Private (Admin only)
 */
router.put(
  "/:id/mark-done",
  authenticate,
  reportController.adminMarkReportDone,
);

/**
 * @route   DELETE /api/v1/reports/:id
 * @desc    Delete a report (soft delete)
 * @access  Private
 */
router.delete("/:id", authenticate, reportController.deleteReport);

// =====================
// Manager Routes
// =====================

/**
 * @route   POST /api/v1/reports/:id/add-managers
 * @desc    Add multiple managers to a report
 * @access  Private (Reporter only)
 */
router.post("/:id/add-managers", authenticate, reportController.addManagers);

/**
 * @route   POST /api/v1/reports/:id/remove-manager
 * @desc    Remove a manager from a report
 * @access  Private (Reporter only)
 */
router.post(
  "/:id/remove-manager",
  authenticate,
  reportController.removeManager,
);

/**
 * @route   GET /api/v1/reports/:id/managers
 * @desc    Get all managers for a report
 * @access  Private
 */
router.get("/:id/managers", authenticate, reportController.getReportManagers);

// =====================
// Task Routes
// =====================

/**
 * @route   POST /api/v1/reports/tasks
 * @desc    Create a new task for a report
 * @access  Private (Reporter or Managers only)
 * @body    { reportId, title, description?, scheduledTime? }
 */
router.post("/tasks", authenticate, reportController.createTask);

/**
 * @route   POST /api/v1/reports/tasks/get
 * @desc    Get all tasks for a report
 * @access  Private
 * @body    { reportId }
 */
router.post("/tasks/get", authenticate, reportController.getReportTasks);

/**
 * @route   POST /api/v1/reports/tasks/detail
 * @desc    Get task by ID with full details
 * @access  Private
 * @body    { taskId }
 */
router.post("/tasks/detail", authenticate, reportController.getTaskById);

/**
 * @route   PUT /api/v1/reports/tasks/update
 * @desc    Update a task
 * @access  Private (Reporter or Managers only)
 * @body    { taskId, title?, description?, status?, scheduledTime? }
 */
router.put("/tasks/update", authenticate, reportController.updateTask);

/**
 * @route   DELETE /api/v1/reports/tasks/delete
 * @desc    Delete a task
 * @access  Private (Reporter or Managers only)
 * @body    { taskId }
 */
router.delete("/tasks/delete", authenticate, reportController.deleteTask);

/**
 * @route   POST /api/v1/reports/tasks/assign
 * @desc    Assign a task to a volunteer
 * @access  Private (Reporter or Managers only)
 * @body    { taskId, volunteerId }
 */
router.post("/tasks/assign", authenticate, reportController.assignTask);

/**
 * @route   POST /api/v1/reports/tasks/unassign
 * @desc    Unassign a volunteer from a task
 * @access  Private (Reporter or Managers only)
 * @body    { taskId, volunteerId }
 */
router.post("/tasks/unassign", authenticate, reportController.unassignTask);

/**
 * @route   GET /api/v1/reports/tasks/my-assigned
 * @desc    Get all tasks assigned to current user (volunteer)
 * @access  Private
 */
router.get(
  "/tasks/my-assigned",
  authenticate,
  reportController.getMyAssignedTasks,
);

/**
 * @route   PUT /api/v1/reports/tasks/status
 * @desc    Update task status (by assigned volunteer)
 * @access  Private (Assigned volunteers only)
 * @body    { taskId, status }
 */
router.put("/tasks/status", authenticate, reportController.updateTaskStatus);

// =====================
// Volunteer Routes
// =====================

/**
 * @route   POST /api/v1/reports/volunteers/join-requests
 * @desc    Create a join request for a report
 * @access  Private
 * @body    { reportId }
 */
router.post(
  "/volunteers/join-requests",
  authenticate,
  reportController.createJoinRequest,
);

/**
 * @route   POST /api/v1/reports/volunteers/join-requests/get
 * @desc    Get join requests for a report
 * @access  Private (Reporter or Managers)
 * @body    { reportId }
 */
router.post(
  "/volunteers/join-requests/get",
  authenticate,
  reportController.getJoinRequests,
);

/**
 * @route   GET /api/v1/reports/volunteers/join-requests/my
 * @desc    Get my join requests
 * @access  Private
 */
router.get(
  "/volunteers/join-requests/my",
  authenticate,
  reportController.getMyJoinRequests,
);

/**
 * @route   PUT /api/v1/reports/volunteers/join-requests/process
 * @desc    Approve or reject a join request
 * @access  Private (Reporter only)
 * @body    { requestId, approved }
 */
router.put(
  "/volunteers/join-requests/process",
  authenticate,
  reportController.processJoinRequest,
);

/**
 * @route   DELETE /api/v1/reports/volunteers/join-requests/cancel
 * @desc    Cancel a join request
 * @access  Private (Volunteer only)
 * @body    { requestId }
 */
router.delete(
  "/volunteers/join-requests/cancel",
  authenticate,
  reportController.cancelJoinRequest,
);

/**
 * @route   POST /api/v1/reports/volunteers/approved
 * @desc    Get approved volunteers for a report
 * @access  Private
 * @body    { reportId }
 */
router.post(
  "/volunteers/approved",
  authenticate,
  reportController.getApprovedVolunteers,
);

// =====================
// Result Routes
// =====================

/**
 * @route   POST /api/v1/reports/results
 * @desc    Submit a result for a report
 * @access  Private (Manager only)
 * @body    { reportId, description?, mediaFiles? }
 */
router.post("/results", authenticate, reportController.submitResult);

/**
 * @route   POST /api/v1/reports/results/get
 * @desc    Get all results for a report
 * @access  Private
 * @body    { reportId }
 */
router.post("/results/get", authenticate, reportController.getReportResults);

/**
 * @route   POST /api/v1/reports/results/detail
 * @desc    Get result detail by ID
 * @access  Private
 * @body    { resultId }
 */
router.post("/results/detail", authenticate, reportController.getResultDetail);

/**
 * @route   PUT /api/v1/reports/results/update
 * @desc    Update a result
 * @access  Private (Submitting Manager only)
 * @body    { resultId, description? }
 */
router.put("/results/update", authenticate, reportController.updateResult);

/**
 * @route   PUT /api/v1/reports/results/process
 * @desc    Approve or reject a result
 * @access  Private (Reporter only)
 * @body    { resultId, approved }
 */
router.put("/results/process", authenticate, reportController.processResult);

export default router;
